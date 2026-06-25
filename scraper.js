/**
 * scraper.js — Main ChatGPT Playwright Automation Script
 *
 * Reads prompts from CSV → Sends each to ChatGPT → Intercepts network response
 * → Extracts result_source, citations, GPT response → Writes back to CSV
 *
 * Usage:
 *   npm start          → Process all unprocessed prompts
 *   npm test           → Dry run (2 prompts, no CSV write)
 *   node scraper.js --from 10   → Start from row index 10
 *   node scraper.js --limit 20  → Process only 20 prompts
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { readCSV, writeCSV } = require('./utils/csvHandler');
const { parseSSEBody, extractData } = require('./utils/responseParser');

// ── Config ─────────────────────────────────────────────────────────────────────
const AUTH_FILE = path.join(__dirname, 'auth.json');

// ⚠️  Using a dedicated local directory inside the project to avoid locking conflicts with your personal Chrome
const CHROME_USER_DATA = path.join(__dirname, 'chrome-profile');
const CHROME_PROFILE = 'Default';  // The profile subfolder name
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const INPUT_CSV_FILE = path.join(__dirname, 'geo_aeo_result_source_dataset.csv');
const OUTPUT_CSV_FILE = path.join(__dirname, 'geo_aeo_result_source_dataset_output.csv');

const DRY_RUN = process.argv.includes('--dry-run');
const FROM_INDEX = parseInt(process.argv.find(a => a.startsWith('--from='))?.split('=')[1] || '0', 10);
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999', 10);

const DELAY_BETWEEN_PROMPTS_MS = 4000;  // Pause between prompts (ms)
const RESPONSE_TIMEOUT_MS = 180000;     // Max wait for GPT to respond (3 min)
const GENERATION_TIMEOUT_MS = 180000;   // Max wait for generation to stop

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ❌ ${msg}`);
}

function safeWriteCSV(filePath, rows) {
  try {
    writeCSV(filePath, rows);
    return true;
  } catch (err) {
    if (err.code === 'EBUSY' || err.message.includes('EBUSY') || err.message.includes('locked')) {
      logError(`Cannot write to CSV: ${filePath} (File is locked/open in Excel).`);
      logError(`👉 Please CLOSE the CSV file in Excel and press any key in the terminal to retry...`);
      try {
        require('child_process').execSync('pause', { stdio: 'inherit' });
        return safeWriteCSV(filePath, rows); // Retry
      } catch (_) {
        logError('Retry failed. Please close Excel and run the scraper again.');
        process.exit(1);
      }
    } else {
      throw err;
    }
  }
}

/**
 * Dismiss common ChatGPT dialogs/popups that block interaction.
 */
async function dismissDialogs(page) {
  const dismissSelectors = [
    'button:has-text("Stay logged out")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Dismiss")',
    'button:has-text("Skip")',
    'button:has-text("No thanks")',
    '[data-testid="close-button"]',
    'button[aria-label="Close"]'
  ];

  for (const sel of dismissSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(500);
      }
    } catch (_e) { /* ignore */ }
  }
}

/**
 * Wait for the ChatGPT input box to be visible and return its selector.
 */
async function waitForChatInput(page, timeout = 30000) {
  const candidates = [
    '#prompt-textarea',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea'
  ];

  for (const sel of candidates) {
    try {
      await page.waitForSelector(sel, { timeout, state: 'visible' });
      return sel;
    } catch (_e) { /* try next */ }
  }

  throw new Error('Chat input not found. Is ChatGPT logged in?');
}

/**
 * Type the prompt into the chat input and hit Send.
 */
async function sendPrompt(page, prompt) {
  const inputSel = await waitForChatInput(page, 20000);

  // Focus the input
  await page.click(inputSel);
  await page.waitForTimeout(300);

  // Clear existing text
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);

  // For contenteditable, fill() may not work — use type()
  try {
    await page.fill(inputSel, prompt);
  } catch (_e) {
    await page.click(inputSel);
    await page.keyboard.type(prompt, { delay: 10 });
  }

  await page.waitForTimeout(400);

  // Try the send button first, then fall back to Enter
  const sendBtn = await page.$(
    '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]'
  );

  if (sendBtn && await sendBtn.isEnabled()) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

/**
 * Wait for the GPT generation to fully complete (stop button disappears).
 */
async function waitForGenerationComplete(page) {
  // ChatGPT shows a stop button while generating
  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]'
  ];

  const stopSel = stopSelectors.join(', ');

  // 1. Wait for stop button to APPEAR (generation started) — optional step
  try {
    await page.waitForSelector(stopSel, { timeout: 15000, state: 'visible' });
    log('   ⚡ Generation started (stop button visible)');
  } catch (_e) {
    log('   ⚡ Generation started (stop button not detected, may be fast response)');
  }

  // 2. Wait for stop button to DISAPPEAR (generation complete)
  try {
    await page.waitForSelector(stopSel, { timeout: GENERATION_TIMEOUT_MS, state: 'detached' });
    log('   ✅ Generation complete (stop button gone)');
  } catch (_e) {
    // Fallback: wait for send button to become active again
    log('   ⏳ Fallback: waiting for send button to re-enable...');
    await page.waitForSelector(
      '[data-testid="send-button"]:not([disabled]), button[aria-label="Send prompt"]:not([disabled])',
      { timeout: 30000 }
    ).catch(() => { });
  }

  // Small buffer for DOM to settle
  await page.waitForTimeout(1500);
}

/**
 * Navigate to a fresh ChatGPT conversation.
 */
async function navigateToNewChat(page) {
  log('   ➡️ Starting navigation to new chat...');
  // Try the "New chat" button in sidebar
  const newChatSelectors = [
    'a[href="/"]',
    'button[aria-label="New chat"]',
    '[data-testid="create-new-chat-button"]',
    'a[data-testid="create-new-chat-button"]'
  ];

  for (const sel of newChatSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        log(`   ➡️ Clicking new chat button (${sel})`);
        await el.click();
        await page.waitForTimeout(2000);
        return;
      }
    } catch (_e) { /* try next */ }
  }

  // Fallback: navigate to root
  log('   ➡️ Navigating to chatgpt.com root (fallback)...');
  try {
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    log('   ➡️ Fallback navigation finished');
  } catch (err) {
    logError(`Fallback navigation failed/timed out: ${err.message}`);
  }
  await page.waitForTimeout(2000);
}

/**
 * Process a single prompt: send it, intercept the response, extract data.
 */
async function processPrompt(page, row, index, total) {
  const promptPreview = row.prompt.length > 70
    ? row.prompt.slice(0, 70) + '...'
    : row.prompt;

  log(`\n── [${index + 1}/${total}] ${promptPreview}`);

  // ── Network Debug Listener ────────────────────────────────────────────────
  const responseListener = (res) => {
    try {
      const url = res.url();
      if (url.includes('/backend-') || url.includes('conversation')) {
        const method = res.request().method();
        const status = res.status();
        const cType = res.headers()['content-type'] || '(none)';
        log(`   🔍 [Network Debug] ${method} ${url} | Status: ${status} | Content-Type: ${cType}`);
      }
    } catch (_) {}
  };
  page.on('response', responseListener);

  try {
    // ── Set up network interceptor BEFORE sending the prompt ──────────────────
    // We capture the SSE body from the /backend-api/conversation POST endpoint
    const responsePromise = page.waitForResponse(
      (response) => {
        const url = response.url();
        const isConversation = url.includes('/conversation') && (url.includes('/backend-api/') || url.includes('/backend-anon/'));
        const isPost = response.request().method() === 'POST';
        const contentType = response.headers()['content-type'] || '';
        const isEventStream = contentType.includes('text/event-stream');
        return isConversation && isPost && isEventStream;
      },
      { timeout: RESPONSE_TIMEOUT_MS }
    );

    // ── Send prompt ────────────────────────────────────────────────────────────
    try {
      await sendPrompt(page, row.prompt);
      log('   ✉️  Prompt sent');
    } catch (err) {
      const msg = `Failed to send prompt: ${err.message}`;
      logError(msg);
      return { ...row, notes: msg, gpt_response: '', citations_raw: '[]' };
    }

    // ── Wait for network response object ─────────────────────────────────────
    let networkResponse;
    try {
      networkResponse = await responsePromise;
      log(`   📡 Network response received. Status: ${networkResponse.status()}`);
    } catch (err) {
      const msg = `Network response timeout: ${err.message}`;
      logError(msg);
      return { ...row, notes: msg, gpt_response: '', citations_raw: '[]' };
    }

    // ── Wait for generation to fully complete (UI signal) ─────────────────────
    await waitForGenerationComplete(page);

    // ── Read the full SSE stream body ─────────────────────────────────────────
    let sseRaw = '';
    try {
      const bodyBuffer = await networkResponse.body();
      sseRaw = bodyBuffer.toString('utf-8');
      log(`   📦 SSE body captured: ${sseRaw.length.toLocaleString()} bytes`);
      if (sseRaw.length > 0) {
        log(`   📝 Raw body sample (first 200 chars): "${sseRaw.slice(0, 200).replace(/\r?\n/g, ' ')}"`);
      }
    } catch (err) {
      const msg = `Failed to read response body: ${err.message}`;
      logError(msg);
      return { ...row, notes: msg, gpt_response: '', citations_raw: '[]' };
    }

    // ── Parse SSE chunks ──────────────────────────────────────────────────────
    const chunks = parseSSEBody(sseRaw);
    log(`   🔍 Parsed ${chunks.length} SSE chunks`);
    try {
      fs.writeFileSync(path.join(__dirname, 'debug_chunks.json'), JSON.stringify(chunks, null, 2), 'utf-8');
      log('   📂 Saved parsed chunks to debug_chunks.json for structure inspection');
    } catch (_) {}

    if (chunks.length === 0) {
      const msg = 'No SSE chunks parsed — response may be empty or malformed';
      logError(msg);
      return { ...row, notes: msg, gpt_response: '', citations_raw: '[]' };
    }

    // ── Extract data ──────────────────────────────────────────────────────────
    const extracted = extractData(chunks);

    log(`   🏷️  result_source  : "${extracted.resultSource || '(none)'}"`);
    log(`   📚 citations      : ${extracted.citations.length}`);
    log(`   🌐 domains        : ${extracted.citationDomains || '(none)'}`);
    log(`   📅 pub_date       : ${extracted.pubDate || '(none)'}`);
    log(`   📝 response len   : ${extracted.gptResponse.length} chars`);

    const freqs = extracted.resultSourceFrequencies || {};

    return {
      ...row,
      result_source: extracted.resultSource,
      pub_date: extracted.pubDate,
      snippet_length: extracted.snippetLength,
      citation_domains: extracted.citationDomains,
      notes: '',
      gpt_response: extracted.gptResponse,
      citations_raw: extracted.citationsRaw,
      
      // New Columns
      citations_count: extracted.citations.length,
      result_source_count: extracted.resultSourceCount,
      result_sources_distribution: Object.entries(freqs).map(([k, v]) => `${k}: ${v}`).join('; '),
      source_bright_count: freqs['bright'] || 0,
      source_labrador_count: freqs['labrador'] || 0,
      source_oxylabs_count: freqs['oxylabs'] || 0,
      source_serp_count: freqs['serp'] || 0,
      source_bing_count: freqs['bing'] || 0,
      
      // New Citation URL Columns grouped by source
      source_bright_citations: extracted.sourceBrightCitations,
      source_labrador_citations: extracted.sourceLabradorCitations,
      source_oxylabs_citations: extracted.sourceOxylabsCitations,
      source_serp_citations: extracted.sourceSerpCitations,
      source_bing_citations: extracted.sourceBingCitations
    };
  } finally {
    page.off('response', responseListener);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ChatGPT Dataset Builder — Playwright Automation');
  console.log('══════════════════════════════════════════════════════════');

  if (DRY_RUN) {
    console.log('  ⚠️  DRY RUN MODE — CSV will NOT be modified');
  }
  console.log('');

  // ── Ensure local profile dir exists ────────────────────────────────────────
  if (!fs.existsSync(CHROME_USER_DATA)) {
    log('📁 Creating local chrome-profile directory...');
    fs.mkdirSync(CHROME_USER_DATA, { recursive: true });
  }

  // ── Read CSV ─────────────────────────────────────────────────────────────
  let rows;
  if (fs.existsSync(OUTPUT_CSV_FILE)) {
    log(`Found existing output CSV. Loading for resume: ${OUTPUT_CSV_FILE}`);
    rows = readCSV(OUTPUT_CSV_FILE);
  } else {
    log(`No existing output CSV found. Starting fresh from input CSV: ${INPUT_CSV_FILE}`);
    rows = readCSV(INPUT_CSV_FILE);
  }
  log(`Loaded ${rows.length} rows`);

  // Ensure new output columns exist on all rows
  rows = rows.map((row) => ({
    ...row,
    gpt_response: row.gpt_response || '',
    citations_raw: row.citations_raw || '',
    citations_count: row.citations_count || '',
    result_source_count: row.result_source_count || '',
    result_sources_distribution: row.result_sources_distribution || '',
    source_bright_count: row.source_bright_count || '0',
    source_labrador_count: row.source_labrador_count || '0',
    source_oxylabs_count: row.source_oxylabs_count || '0',
    source_serp_count: row.source_serp_count || '0',
    source_bing_count: row.source_bing_count || '0',
    source_bright_citations: row.source_bright_citations || '',
    source_labrador_citations: row.source_labrador_citations || '',
    source_oxylabs_citations: row.source_oxylabs_citations || '',
    source_serp_citations: row.source_serp_citations || '',
    source_bing_citations: row.source_bing_citations || ''
  }));

  // Find rows that haven't been processed yet (gpt_response is empty)
  const unprocessed = rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => !row.gpt_response || row.gpt_response.trim() === '');

  log(`Found ${unprocessed.length} unprocessed rows`);

  if (unprocessed.length === 0) {
    log('✅ All rows already processed. Nothing to do.');
    return;
  }

  // Apply --from and --limit flags
  const sliced = unprocessed.slice(FROM_INDEX, FROM_INDEX + (DRY_RUN ? 2 : LIMIT));
  log(`Will process ${sliced.length} rows${DRY_RUN ? ' (dry run)' : ''}`);

  log('Launching Chrome with local automation profile...');
  log(`   User Data : ${CHROME_USER_DATA}`);
  log(`   Profile   : ${CHROME_PROFILE}`);

  if (!fs.existsSync(CHROME_EXE)) {
    logError(`Chrome executable not found at: ${CHROME_EXE}`);
    logError('Please make sure Google Chrome is installed, or update CHROME_EXE in scraper.js.');
    process.exit(1);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_USER_DATA, {
      headless: false,
      executablePath: CHROME_EXE,
      args: [
        `--profile-directory=${CHROME_PROFILE}`,  // ← selects Default profile
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null,
    });
  } catch (err) {
    logError('Failed to launch Chrome: ' + err.message);
    if (err.message.includes('already in use') || err.message.includes('lock')) {
      logError('👉 The local chrome-profile directory is locked.');
      logError('   Please make sure no other login or scraper script is running.');
    }
    process.exit(1);
  }

  // Import cookies from auth.json if they exist
  if (fs.existsSync(AUTH_FILE)) {
    log(`Loading authentication state from ${AUTH_FILE}...`);
    try {
      const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      if (state.cookies && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        log(`   Imported ${state.cookies.length} cookies into browser context.`);
      }
    } catch (e) {
      logError(`Failed to load cookies from auth.json: ${e.message}`);
    }
  }

  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', () => { });

  // Navigate to ChatGPT
  log('Navigating to ChatGPT...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await dismissDialogs(page);

  // ── Step 4: Detect login state by cookies and DOM ─────────────────────────
  const scraperCookies = await context.cookies('https://chatgpt.com');
  let isLoggedIn = scraperCookies.some(c => c.name === '__Secure-next-auth.session-token' && c.value && c.value.length > 10);

  if (!isLoggedIn) {
    // Fallback DOM check: if prompt textarea exists but login button is absent
    try {
      const hasInput = await page.$('#prompt-textarea');
      if (hasInput) {
        const hasLoginBtn = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="login-button"]');
          if (btn && btn.offsetHeight > 0) return true;
          const elements = Array.from(document.querySelectorAll('button, a'));
          for (const el of elements) {
            const text = (el.textContent || '').trim().toLowerCase();
            if ((text === 'log in' || text === 'sign in') && el.offsetHeight > 0) {
              return true;
            }
          }
          return false;
        });
        if (!hasLoginBtn) {
          isLoggedIn = true;
        }
      }
    } catch (_) { }
  }

  if (!isLoggedIn) {
    logError('Not logged in to ChatGPT account (session token not found in cookies or DOM).');
    logError('Please close this browser, run: npm run login  to log in first, and try again.');
    await context.close();
    process.exit(1);
  }

  log('✅ Logged in — chat interface ready\n');

  let processedCount = 0;
  let errorCount = 0;

  // ── Process each prompt ───────────────────────────────────────────────────
  for (const { row, idx } of sliced) {
    try {
      const updatedRow = await processPrompt(page, row, processedCount, sliced.length);
      rows[idx] = updatedRow;
      processedCount++;

      // Save CSV after every single prompt (incremental — no data loss on crash)
      if (!DRY_RUN) {
        safeWriteCSV(OUTPUT_CSV_FILE, rows);
        log(`   💾 CSV saved (${processedCount}/${sliced.length} done)`);
      } else {
        log('   [DRY RUN] CSV write skipped');
      }
    } catch (err) {
      logError(`Unhandled error on row ${row.id}: ${err.message}`);
      rows[idx] = { ...row, notes: `Fatal error: ${err.message}` };
      errorCount++;

      if (!DRY_RUN) {
        safeWriteCSV(OUTPUT_CSV_FILE, rows);
      }
    }

    // Navigate to new chat and pause before next prompt
    if (processedCount < sliced.length) {
      log(`\n⏱️  Pausing ${DELAY_BETWEEN_PROMPTS_MS / 1000}s, then starting new chat...`);
      await navigateToNewChat(page);
      await dismissDialogs(page);
      await page.waitForTimeout(DELAY_BETWEEN_PROMPTS_MS);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Done!');
  console.log(`  ✅ Processed : ${processedCount}`);
  console.log(`  ❌ Errors    : ${errorCount}`);
  console.log(`  📄 Output    : ${OUTPUT_CSV_FILE}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  await context.close();
}

main().catch((e) => {
  logError('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
