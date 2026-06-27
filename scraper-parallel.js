/**
 * scraper-parallel.js — Parallel ChatGPT Scraper
 *
 * Runs N browser contexts simultaneously, each pulling from a shared queue.
 * Only captures: result_source → [URLs] per prompt.
 *
 * Usage:
 *   node scraper-parallel.js                  → 5 parallel browsers, all unprocessed
 *   node scraper-parallel.js --workers=3      → 3 parallel browsers
 *   node scraper-parallel.js --limit=50       → only first 50 unprocessed
 *   node scraper-parallel.js --dry-run        → 2 prompts, no CSV write
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { readCSV, writeCSV } = require('./utils/csvHandler');
const { parseSSEBody } = require('./utils/responseParser');

// Playwright timeout promises can escape try/catch across async boundaries.
// Log them but never crash — the worker's own catch already handles recovery.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('waitForResponse')) return;
  console.error(`[unhandledRejection] ${msg}`);
});

// ── Config ────────────────────────────────────────────────────────────────────
const INPUT_CSV        = path.join(__dirname, 'geo_aeo_result_source_dataset.csv');
const OUTPUT_CSV       = path.join(__dirname, 'geo_aeo_result_source_dataset_output.csv');
const CHROME_EXE       = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const WORKERS      = parseInt(process.argv.find(a => a.startsWith('--workers='))?.split('=')[1] || '5', 10);
const LIMIT        = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1]   || '9999', 10);
const DRY_RUN      = process.argv.includes('--dry-run');
const FORCE_SEARCH = process.argv.includes('--force-search');

// ── Auth file detection ───────────────────────────────────────────────────────
// Looks for auth-1.json, auth-2.json, ... auth-N.json, then falls back to auth.json
// Each worker gets its own account to avoid rate limits.
function detectAuthFiles() {
  const files = [];
  for (let i = 1; i <= 10; i++) {
    const f = path.join(__dirname, `auth-${i}.json`);
    if (fs.existsSync(f)) files.push(f);
  }
  // Fall back to legacy auth.json if no numbered files found
  if (files.length === 0) {
    const legacy = path.join(__dirname, 'auth.json');
    if (fs.existsSync(legacy)) files.push(legacy);
  }
  return files;
}

function getAuthFileForWorker(authFiles, workerId) {
  // Round-robin assignment: worker 1 → auth-1.json, worker 2 → auth-2.json, etc.
  return authFiles[(workerId - 1) % authFiles.length];
}

const DELAY_MS           = 3000;   // between prompts per worker (ms)
const RESPONSE_TIMEOUT   = 180000; // max wait for ChatGPT SSE (ms)
const GENERATION_TIMEOUT = 180000; // max wait for stop button to disappear (ms)

// ── Logging ───────────────────────────────────────────────────────────────────
function log(workerId, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][W${workerId}] ${msg}`);
}
function err(workerId, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}][W${workerId}] ❌ ${msg}`);
}

// ── CSV safe-write (single-threaded JS — no actual race, but we serialize anyway) ──
let writeLock = Promise.resolve();
function saveCSV(rows) {
  writeLock = writeLock.then(() => {
    try {
      writeCSV(OUTPUT_CSV, rows);
    } catch (e) {
      console.error(`[CSV WRITE ERROR] ${e.message}`);
    }
  });
  return writeLock;
}

// ── SSE extraction: only result_source → [urls] ───────────────────────────────

/**
 * Reconstruct the ChatGPT SSE state document from patch operations.
 */
function buildState(chunks) {
  const state = {};

  function setAt(obj, pathStr, val, op) {
    if (!pathStr) {
      if (typeof val === 'object' && val !== null) Object.assign(obj, val);
      return;
    }
    const parts = pathStr.split('/').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      const k = Array.isArray(cur) ? parseInt(parts[i], 10) : parts[i];
      if (i === parts.length - 1) {
        if (op === 'append') {
          if (typeof val === 'string')       cur[k] = (cur[k] || '') + val;
          else if (Array.isArray(val))       cur[k] = (cur[k] || []).concat(val);
          else if (typeof val === 'object')  cur[k] = Object.assign(cur[k] || {}, val);
          else                               cur[k] = val;
        } else if (op === 'add') {
          if (Array.isArray(cur[k])) cur[k].push(val);
          else                       cur[k] = val;
        } else {
          cur[k] = val;
        }
      } else {
        if (!(parts[i] in cur)) {
          cur[parts[i]] = /^\d+$/.test(parts[i + 1] || '') ? [] : {};
        }
        cur = cur[parts[i]];
      }
    }
  }

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.o === 'patch' && Array.isArray(chunk.v)) {
      for (const op of chunk.v) setAt(state, op.p, op.v, op.o);
    } else if (chunk.p !== undefined && chunk.o) {
      setAt(state, chunk.p, chunk.v, chunk.o);
    } else if (typeof chunk.v === 'string' && !chunk.p) {
      setAt(state, '/message/content/parts/0', chunk.v, 'append');
    } else if (chunk.v && typeof chunk.v === 'object') {
      setAt(state, chunk.p || '', chunk.v, chunk.o || 'append');
    }
  }

  return state;
}

/**
 * Recursively collect all objects that have both result_source and url.
 */
function collectSourcedCitations(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;

  if (obj.result_source && (obj.url || obj.source_url)) {
    acc.push({ source: String(obj.result_source).toLowerCase().trim(), url: obj.url || obj.source_url });
  }

  const vals = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of vals) {
    if (v && typeof v === 'object') collectSourcedCitations(v, acc);
  }
  return acc;
}

/**
 * Extract result_source → [urls] map from raw SSE body.
 * Returns: { sourceMap: { bright: [...], serp: [...] }, allSources: [...] }
 */
function extractSourceMap(sseRaw) {
  const chunks = parseSSEBody(sseRaw);
  if (chunks.length === 0) return { sourceMap: {}, allSources: [], error: 'no_chunks' };

  const state = buildState(chunks);

  // Collect citations from all known locations
  const sourcedCitations = [];

  // 1. search_result_groups
  for (const group of state?.message?.metadata?.search_result_groups || []) {
    for (const entry of group?.entries || []) {
      if (entry.result_source && (entry.url || entry.source_url)) {
        sourcedCitations.push({
          source: String(entry.result_source).toLowerCase().trim(),
          url: entry.url || entry.source_url
        });
      }
    }
  }

  // 2. content_references → items
  for (const ref of state?.message?.metadata?.content_references || []) {
    for (const item of ref?.items || []) {
      if (item.result_source && (item.url || item.source_url)) {
        sourcedCitations.push({
          source: String(item.result_source).toLowerCase().trim(),
          url: item.url || item.source_url
        });
      }
    }
  }

  // 3. metadata.citations
  for (const cite of state?.message?.metadata?.citations || []) {
    if (cite.result_source && (cite.url || cite.source_url)) {
      sourcedCitations.push({
        source: String(cite.result_source).toLowerCase().trim(),
        url: cite.url || cite.source_url
      });
    }
  }

  // 4. Deep recursive fallback (catches any nested location)
  const deepFound = collectSourcedCitations(state);
  for (const item of deepFound) {
    const already = sourcedCitations.some(c => c.url === item.url && c.source === item.source);
    if (!already) sourcedCitations.push(item);
  }

  // Build source → urls map (deduplicated per source)
  const sourceMap = {};
  for (const { source, url } of sourcedCitations) {
    if (!sourceMap[source]) sourceMap[source] = [];
    if (!sourceMap[source].includes(url)) sourceMap[source].push(url);
  }

  const allSources = Object.keys(sourceMap);
  return { sourceMap, allSources, error: allSources.length === 0 ? 'no_sources_found' : '' };
}

// ── Browser helpers ───────────────────────────────────────────────────────────

async function dismissDialogs(page) {
  const sels = [
    'button:has-text("Stay logged out")', 'button:has-text("OK")',
    'button:has-text("Got it")', 'button:has-text("Dismiss")',
    'button:has-text("Skip")', 'button:has-text("No thanks")',
    '[data-testid="close-button"]', 'button[aria-label="Close"]'
  ];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click(); await page.waitForTimeout(400); }
    } catch (_) {}
  }
}

async function waitForInput(page, timeout = 25000) {
  for (const sel of ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea']) {
    try {
      await page.waitForSelector(sel, { timeout, state: 'visible' });
      return sel;
    } catch (_) {}
  }
  throw new Error('Chat input not found — are you logged in?');
}

async function sendPrompt(page, prompt) {
  const sel = await waitForInput(page, 20000);
  await page.click(sel);
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  try {
    await page.fill(sel, prompt);
  } catch (_) {
    await page.click(sel);
    await page.keyboard.type(prompt, { delay: 8 });
  }
  await page.waitForTimeout(300);

  const sendBtn = await page.$('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
  if (sendBtn && await sendBtn.isEnabled()) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

async function waitForDone(page) {
  const stopSel = 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';
  try { await page.waitForSelector(stopSel, { timeout: 15000, state: 'visible' }); } catch (_) {}
  try {
    await page.waitForSelector(stopSel, { timeout: GENERATION_TIMEOUT, state: 'detached' });
  } catch (_) {
    await page.waitForSelector('[data-testid="send-button"]:not([disabled])', { timeout: 30000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);
}

async function goNewChat(page) {
  for (const sel of ['a[href="/"]', 'button[aria-label="New chat"]', '[data-testid="create-new-chat-button"]']) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.click(); await page.waitForTimeout(1500); return; }
    } catch (_) {}
  }
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// ── Single prompt processor ───────────────────────────────────────────────────

async function processOne(workerId, page, row) {
  const promptToSend = FORCE_SEARCH ? `Search the web to answer: ${row.prompt}` : row.prompt;
  const preview = promptToSend.length > 60 ? promptToSend.slice(0, 60) + '…' : promptToSend;
  log(workerId, `→ "${preview}"`);

  // Intercept the SSE conversation endpoint BEFORE sending
  let responsePromise = page.waitForResponse(
    (res) => {
      const url = res.url();
      return url.includes('/conversation') &&
        (url.includes('/backend-api/') || url.includes('/backend-anon/')) &&
        res.request().method() === 'POST' &&
        (res.headers()['content-type'] || '').includes('text/event-stream');
    },
    { timeout: RESPONSE_TIMEOUT }
  );
  // Always attach a catch so an abandoned promise never causes an unhandled rejection
  responsePromise.catch(() => {});

  try {
    await sendPrompt(page, promptToSend);
  } catch (e) {
    responsePromise = null;
    return { ...baseOutput(row), notes: `send_failed: ${e.message}` };
  }

  let netRes;
  try {
    netRes = await responsePromise;
    log(workerId, `📡 SSE received (${netRes.status()})`);
  } catch (e) {
    return { ...baseOutput(row), notes: `timeout_waiting_response` };
  }

  await waitForDone(page);

  let sseRaw = '';
  try {
    sseRaw = (await netRes.body()).toString('utf-8');
    log(workerId, `📦 ${sseRaw.length.toLocaleString()} bytes`);
  } catch (e) {
    return { ...baseOutput(row), notes: `body_read_failed: ${e.message}` };
  }

  const { sourceMap, allSources, error } = extractSourceMap(sseRaw);

  if (error) {
    log(workerId, `⚠️  ${error}`);
  }

  log(workerId, `✅ sources: [${allSources.join(', ') || 'none'}]`);
  for (const [src, urls] of Object.entries(sourceMap)) {
    log(workerId, `   ${src}: ${urls.length} URL(s)`);
  }

  return buildOutputRow(row, sourceMap, allSources, error);
}

function baseOutput(row) {
  return {
    id: row.id,
    category: row.category,
    prompt: row.prompt,
    result_sources: '',
    bright_urls: '',
    labrador_urls: '',
    oxylabs_urls: '',
    serp_urls: '',
    bing_urls: '',
    other_sources: '',
    notes: ''
  };
}

const KNOWN_SOURCES = ['bright', 'labrador', 'oxylabs', 'serp', 'bing'];

function buildOutputRow(row, sourceMap, allSources, error) {
  const other = allSources.filter(s => !KNOWN_SOURCES.includes(s));
  const otherMap = {};
  for (const s of other) otherMap[s] = sourceMap[s] || [];

  return {
    id: row.id,
    category: row.category,
    prompt: row.prompt,
    result_sources: allSources.join('; '),
    bright_urls:    (sourceMap.bright    || []).join(' | '),
    labrador_urls:  (sourceMap.labrador  || []).join(' | '),
    oxylabs_urls:   (sourceMap.oxylabs   || []).join(' | '),
    serp_urls:      (sourceMap.serp      || []).join(' | '),
    bing_urls:      (sourceMap.bing      || []).join(' | '),
    other_sources:  other.length ? JSON.stringify(otherMap) : '',
    notes:          error || ''
  };
}

// ── Worker: one browser context, drains the shared queue ─────────────────────

async function runWorker(workerId, browser, cookies, queue, rows, outputRows) {
  log(workerId, 'Starting context...');
  const context = await browser.newContext();
  if (cookies.length > 0) {
    await context.addCookies(cookies);
    log(workerId, `Loaded ${cookies.length} cookies`);
  }

  const page = await context.newPage();
  page.on('pageerror', () => {});

  log(workerId, 'Navigating to ChatGPT...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await dismissDialogs(page);

  // Verify login
  const pageCookies = await context.cookies('https://chatgpt.com');
  const loggedIn = pageCookies.some(c => c.name === '__Secure-next-auth.session-token' && c.value?.length > 10);
  if (!loggedIn) {
    err(workerId, 'Not logged in — skipping this worker. Run: npm run login');
    await context.close();
    return;
  }
  log(workerId, '✅ Logged in');

  let first = true;
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    if (!first) {
      await goNewChat(page);
      await dismissDialogs(page);
      await page.waitForTimeout(DELAY_MS);
    }
    first = false;

    try {
      const result = await processOne(workerId, page, item.row);
      outputRows[item.idx] = result;
      rows[item.origIdx] = { ...rows[item.origIdx], ...result, _done: true };

      if (!DRY_RUN) {
        await saveCSV(outputRows.filter(Boolean));
        log(workerId, `💾 Saved (queue remaining: ${queue.length})`);
      }
    } catch (e) {
      err(workerId, `Unhandled: ${e.message}`);
      outputRows[item.idx] = { ...baseOutput(item.row), notes: `fatal: ${e.message}` };
    }
  }

  log(workerId, 'Queue empty — closing context');
  await context.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Detect available auth files
  const authFiles = detectAuthFiles();
  if (authFiles.length === 0) {
    console.error('[init] No auth files found. Run: npm run login:1');
    process.exit(1);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ChatGPT Parallel Scraper — result_source → URLs');
  console.log(`  Accounts : ${authFiles.length} (${authFiles.map(f => path.basename(f)).join(', ')})`);
  console.log(`  Workers  : ${DRY_RUN ? 1 : WORKERS}  |  Limit: ${LIMIT}  |  DryRun: ${DRY_RUN}`);
  console.log('══════════════════════════════════════════════════════════\n');

  // Always load the full input CSV as source of truth for all rows
  // Then overlay completed results from the output CSV (handles partial/crashed runs)
  console.log(`[init] Loading input: ${INPUT_CSV}`);
  const inputRows = readCSV(INPUT_CSV);
  console.log(`[init] ${inputRows.length} total rows in input`);

  // Build a map of completed results keyed by row id
  const doneById = {};
  if (fs.existsSync(OUTPUT_CSV)) {
    const outputDone = readCSV(OUTPUT_CSV);
    for (const r of outputDone) {
      const hasResult = r.result_sources && r.result_sources.trim() !== '';
      const isNoSources = r.notes && r.notes.trim() === 'no_sources_found';
      // If FORCE_SEARCH is enabled, we retry 'no_sources_found' to get search results.
      // Otherwise, we skip them to avoid running them repeatedly.
      if (hasResult || (isNoSources && !FORCE_SEARCH)) {
        doneById[String(r.id)] = r;
      }
    }
    console.log(`[init] ${Object.keys(doneById).length} already completed (from output CSV)`);
  }

  // Merge: use completed result if available, otherwise use raw input row
  const rows = inputRows.map(r => doneById[String(r.id)] ? { ...r, ...doneById[String(r.id)] } : r);

  // Find unprocessed rows
  const unprocessed = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!doneById[String(r.id)]) {
      unprocessed.push({ row: r, origIdx: i });
    }
  }
  console.log(`[init] ${unprocessed.length} unprocessed rows`);

  if (unprocessed.length === 0) {
    console.log('[init] ✅ All done. Nothing to process.');
    return;
  }

  // Build queue with limit
  const toProcess = unprocessed.slice(0, DRY_RUN ? 2 : LIMIT);
  console.log(`[init] Will process ${toProcess.length} rows\n`);

  // Assign sequential idx for outputRows positioning
  const queue = toProcess.map((item, idx) => ({ ...item, idx }));
  const outputRows = new Array(toProcess.length).fill(null);

  // Copy existing output rows into outputRows so CSV write is complete
  // We'll prepend the already-processed rows in the final write
  const alreadyDone = rows
    .filter((_, i) => !toProcess.some(t => t.origIdx === i))
    .map(r => ({
      id: r.id, category: r.category, prompt: r.prompt,
      result_sources: r.result_sources || '',
      bright_urls: r.bright_urls || '',
      labrador_urls: r.labrador_urls || '',
      oxylabs_urls: r.oxylabs_urls || '',
      serp_urls: r.serp_urls || '',
      bing_urls: r.bing_urls || '',
      other_sources: r.other_sources || '',
      notes: r.notes || ''
    }));

  // Override saveCSV to include already-done rows
  const origSave = saveCSV;
  function saveAll() {
    const newDone = outputRows.filter(Boolean);
    const merged = [...alreadyDone, ...newDone];
    // Sort by id if numeric
    merged.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
    writeLock = writeLock.then(() => {
      try { writeCSV(OUTPUT_CSV, merged); } catch (e) { console.error(`[CSV] ${e.message}`); }
    });
    return writeLock;
  }
  // Monkey-patch the save inside runWorker to use saveAll
  // (We'll pass saveAll as a callback instead)

  // Launch system Chrome (already installed — no download needed)
  if (!fs.existsSync(CHROME_EXE)) {
    console.error(`[init] Chrome not found at: ${CHROME_EXE}`);
    console.error('[init] Update CHROME_EXE in scraper-parallel.js to your Chrome path.');
    process.exit(1);
  }
  console.log('[init] Launching Chrome...');
  const browser = await chromium.launch({
    headless: false,
    executablePath: CHROME_EXE,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Run workers in parallel — each gets its own account to avoid rate limits
  const workerCount = DRY_RUN ? 1 : Math.min(WORKERS, toProcess.length);
  console.log(`[init] Starting ${workerCount} worker(s) across ${authFiles.length} account(s) (staggered launch to avoid conflicts)\n`);
  const workerPromises = Array.from({ length: workerCount }, async (_, i) => {
    const workerAuth = getAuthFileForWorker(authFiles, i + 1);
    if (i > 0) {
      log(i + 1, `Waiting ${i * 4}s to stagger launch...`);
      await new Promise(resolve => setTimeout(resolve, i * 4000));
    }
    return runWorkerWithSave(i + 1, browser, workerAuth, queue, rows, outputRows, saveAll);
  });

  await Promise.all(workerPromises);
  await browser.close();

  // Final save
  if (!DRY_RUN) await saveAll();

  const done = outputRows.filter(Boolean).length;
  const errors = outputRows.filter(r => r && r.notes).length;
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Done!');
  console.log(`  ✅ Processed : ${done}`);
  console.log(`  ⚠️  With notes: ${errors}`);
  console.log(`  📄 Output    : ${OUTPUT_CSV}`);
  console.log('══════════════════════════════════════════════════════════\n');
}

// Wrapper that passes saveAll
async function runWorkerWithSave(workerId, browser, authFile, queue, rows, outputRows, saveAll) {
  log(workerId, 'Starting context...');
  // Restore full session: cookies + localStorage (storageState saved by login.js)
  const context = await browser.newContext({ storageState: authFile });
  log(workerId, 'Session state loaded');

  const page = await context.newPage();
  page.on('pageerror', () => {});

  log(workerId, 'Navigating to ChatGPT...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await dismissDialogs(page);

  // Check login: cookie first, then DOM fallback
  const pageCookies = await context.cookies('https://chatgpt.com');
  let loggedIn = pageCookies.some(c => c.name === '__Secure-next-auth.session-token' && c.value?.length > 10);

  if (!loggedIn) {
    // DOM fallback: prompt textarea visible + no login button
    try {
      const hasInput = await page.$('#prompt-textarea');
      if (hasInput) {
        const hasLoginBtn = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="login-button"]');
          if (btn && btn.offsetHeight > 0) return true;
          for (const el of document.querySelectorAll('button, a')) {
            const t = (el.textContent || '').trim().toLowerCase();
            if ((t === 'log in' || t === 'sign in') && el.offsetHeight > 0) return true;
          }
          return false;
        });
        loggedIn = !hasLoginBtn;
      }
    } catch (_) {}
  }

  if (!loggedIn) {
    err(workerId, 'Not logged in — skipping. Run: npm run login');
    await context.close();
    return;
  }
  log(workerId, '✅ Logged in');

  let consecutiveFailures = 0;
  let first = true;
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    if (!first) {
      await goNewChat(page).catch(() => {});
      await dismissDialogs(page).catch(() => {});
      await page.waitForTimeout(DELAY_MS);
    }
    first = false;

    try {
      // Check if rate limit modal is visible before processing
      const rateLimitSel = '[data-testid="modal-conversation-history-rate-limit"], #modal-conversation-history-rate-limit';
      const isRateLimited = await page.isVisible(rateLimitSel).catch(() => false);
      if (isRateLimited) {
        err(workerId, 'Rate limit modal is visible! Re-queuing item and stopping worker.');
        queue.unshift(item);
        break;
      }

      const result = await processOne(workerId, page, item.row);
      
      const isFailed = result.notes && (
        result.notes.includes('send_failed') ||
        result.notes.includes('timeout_waiting_response') ||
        result.notes.includes('body_read_failed')
      );

      if (isFailed) {
        consecutiveFailures++;
        err(workerId, `Prompt failed (Consecutive failures: ${consecutiveFailures}). Notes: ${result.notes}`);
        
        // Check if rate limit modal appeared during the send
        const hasRateLimitNow = await page.isVisible(rateLimitSel).catch(() => false);
        if (hasRateLimitNow || consecutiveFailures >= 2) {
          err(workerId, `Stopping worker due to ${hasRateLimitNow ? 'rate limit modal' : 'consecutive failures'}. Re-queuing current item.`);
          queue.unshift(item);
          break;
        }
      } else {
        consecutiveFailures = 0; // reset on success
      }

      outputRows[item.idx] = result;

      if (!DRY_RUN) {
        await saveAll();
        log(workerId, `💾 Saved (queue remaining: ${queue.length})`);
      } else {
        log(workerId, '[dry-run] skipped CSV write');
      }
    } catch (e) {
      err(workerId, `Unhandled on row ${item.row.id}: ${e.message}`);
      // Re-queue on fatal unhandled exception
      queue.unshift(item);
      break;
    }
  }

  log(workerId, 'Queue empty — closing');
  await context.close().catch(() => {});
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
