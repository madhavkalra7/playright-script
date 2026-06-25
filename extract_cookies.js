/**
 * extract_cookies.js
 *
 * Reads ChatGPT cookies DIRECTLY from your Chrome browser's SQLite cookie database
 * and builds auth.json — no browser window needed, no conflicts.
 *
 * NOTE: Chrome must be CLOSED or the cookie file must be accessible.
 * If Chrome is open, we copy the cookie file first (Windows allows this).
 *
 * Usage:
 *   node extract_cookies.js
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AUTH_FILE = path.join(__dirname, 'auth.json');

// Chrome cookie DB location (Windows)
const CHROME_COOKIES_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'
);

// Domains we want cookies from
const TARGET_DOMAINS = ['chatgpt.com', 'openai.com', 'auth0.com', 'accounts.google.com'];

// Known OpenAI auth cookie names — we log these specially
const AUTH_COOKIE_NAMES = [
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  '__Host-next-auth.csrf-token',
  'oai-auth',
  '__Secure-next-auth.callback-url',
  'oai-sc',
  '__cf_bm',
  'cf_clearance'
];

function chromiumTimestampToUnix(chromiumTs) {
  // Chrome stores timestamps as microseconds since Jan 1, 1601
  // Unix epoch is Jan 1, 1970 — difference is 11644473600 seconds
  if (!chromiumTs || chromiumTs === 0) return -1;
  return (chromiumTs / 1e6) - 11644473600;
}

function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  Chrome Cookie Extractor for ChatGPT Auth');
  console.log('══════════════════════════════════════════════════');
  console.log('');

  if (!fs.existsSync(CHROME_COOKIES_PATH)) {
    console.error(`❌ Chrome cookie file not found at:`);
    console.error(`   ${CHROME_COOKIES_PATH}`);
    console.error(`   Make sure Google Chrome is installed.`);
    process.exit(1);
  }

  console.log('📂 Reading Chrome cookies from:');
  console.log(`   ${CHROME_COOKIES_PATH}`);
  console.log('');

  // Copy cookie DB to temp location (Chrome may have it locked)
  const tempCookiePath = path.join(os.tmpdir(), 'chrome_cookies_copy.db');
  fs.copyFileSync(CHROME_COOKIES_PATH, tempCookiePath);

  let db;
  try {
    db = new Database(tempCookiePath, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error('❌ Could not open cookie database:', e.message);
    console.error('   Try closing Chrome completely and running again.');
    process.exit(1);
  }

  // Query all chatgpt.com and openai.com cookies
  const placeholders = TARGET_DOMAINS.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      name,
      value,
      encrypted_value,
      host_key,
      path,
      expires_utc,
      is_httponly,
      is_secure,
      samesite,
      source_scheme
    FROM cookies
    WHERE (
      host_key LIKE '%.chatgpt.com'
      OR host_key LIKE '%chatgpt.com'
      OR host_key LIKE '%.openai.com'
      OR host_key LIKE '%openai.com'
    )
    ORDER BY host_key, name
  `).all();

  db.close();
  fs.unlinkSync(tempCookiePath);

  console.log(`🍪 Found ${rows.length} cookies for chatgpt.com / openai.com`);
  console.log('');

  if (rows.length === 0) {
    console.error('❌ No cookies found!');
    console.error('   This means you are NOT logged in to ChatGPT in Chrome.');
    console.error('');
    console.error('   To fix:');
    console.error('   1. Open Chrome manually');
    console.error('   2. Go to https://chatgpt.com');
    console.error('   3. Log in with madhavkalra2005@gmail.com');
    console.error('   4. Run this script again: node extract_cookies.js');
    process.exit(1);
  }

  // Build auth.json cookie array in Playwright format
  const sameSiteMap = { 0: 'None', 1: 'Lax', 2: 'Strict', '-1': 'None' };

  const playwrightCookies = rows.map(row => {
    // Chrome encrypts cookie values on Windows (DPAPI)
    // We use the plain text value if available; encrypted_value handling requires native code
    const value = row.value || ''; // encrypted_value cannot be easily decrypted here

    const domain = row.host_key.startsWith('.')
      ? row.host_key
      : row.host_key;

    const expiresUnix = chromiumTimestampToUnix(row.expires_utc);

    return {
      name: row.name,
      value: value,
      domain: domain,
      path: row.path || '/',
      expires: expiresUnix,
      httpOnly: row.is_httponly === 1,
      secure: row.is_secure === 1,
      sameSite: sameSiteMap[row.samesite] || 'None'
    };
  });

  // Check if we got auth cookies
  const foundAuthCookies = playwrightCookies.filter(c => AUTH_COOKIE_NAMES.includes(c.name));
  const hasValue = foundAuthCookies.filter(c => c.value && c.value.length > 0);

  console.log('🔑 Auth-related cookies found:');
  foundAuthCookies.forEach(c => {
    const hasVal = c.value && c.value.length > 0;
    console.log(`   ${hasVal ? '✅' : '⚠️ '} ${c.name}: ${hasVal ? `${c.value.slice(0, 30)}...` : '(encrypted — needs special handling)'}`);
  });
  console.log('');

  if (hasValue.length === 0) {
    console.log('⚠️  WARNING: Cookie values appear to be encrypted by Chrome (DPAPI).');
    console.log('   This is expected on Windows — Chrome encrypts sensitive cookies.');
    console.log('');
    console.log('   We need to use a different method: launching Playwright with');
    console.log('   your ACTUAL Chrome user data directory instead.');
    console.log('');
    console.log('   Running alternative login method now...');
    console.log('');

    // Fall back to launching browser with user data dir
    launchBrowserWithUserDataDir();
    return;
  }

  // Build auth.json
  const authState = {
    cookies: playwrightCookies,
    origins: []
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authState, null, 2), 'utf-8');
  console.log(`✅ auth.json saved with ${playwrightCookies.length} cookies`);
  console.log(`   You can now run: npm start`);
}

async function launchBrowserWithUserDataDir() {
  const { chromium } = require('playwright');
  const CHROME_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  const PLAYWRIGHT_PROFILE_DIR = path.join(__dirname, 'chrome-profile');

  console.log('🚀 Opening ChatGPT using your Chrome profile directory...');
  console.log('   (This reuses your existing login — no need to re-enter credentials)');
  console.log('');

  // Use Playwright Chromium but point it at a COPY of the Chrome user data
  // (We can't use the live Chrome dir while Chrome is open)
  
  try {
    const context = await chromium.launchPersistentContext(PLAYWRIGHT_PROFILE_DIR, {
      headless: false,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null
    });

    const page = context.pages()[0] || await context.newPage();
    console.log('🌐 Navigating to ChatGPT...');
    await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Please log in to ChatGPT in the browser window  ║');
    console.log('║  using "Continue with Google"                    ║');
    console.log('║  → Choose: madhavkalra2005@gmail.com             ║');
    console.log('║                                                   ║');
    console.log('║  The window will auto-close once logged in.      ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log('⏳ Waiting up to 5 minutes...');

    const deadline = Date.now() + 5 * 60 * 1000;
    let loggedIn = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      const cookies = await context.cookies('https://chatgpt.com');
      const authCookie = cookies.find(c => AUTH_COOKIE_NAMES.includes(c.name) && c.value);
      
      if (authCookie) {
        loggedIn = true;
        console.log(`\n✅ Auth detected: ${authCookie.name}`);
        break;
      }

      // Also check DOM for logged-in state
      const isOnChat = await page.evaluate(() => {
        return window.location.pathname === '/' && !document.querySelector('[data-testid="login-button"]');
      }).catch(() => false);

      if (isOnChat) {
        await page.waitForTimeout(2000);
        const cookies2 = await context.cookies('https://chatgpt.com');
        if (cookies2.some(c => c.name.includes('session') || c.name === 'oai-sc')) {
          loggedIn = true;
          console.log('\n✅ Logged in (session cookies found)!');
          break;
        }
      }

      process.stdout.write('.');
    }

    if (!loggedIn) {
      console.error('\n❌ Login not detected. Please try again.');
      await context.close();
      process.exit(1);
    }

    await page.waitForTimeout(2000);
    await context.storageState({ path: AUTH_FILE });
    
    const saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    console.log(`\n💾 Saved ${saved.cookies.length} cookies to auth.json`);
    console.log('   Run: npm start');
    
    await context.close();
  } catch (err) {
    console.error('❌ Failed to launch browser:', err.message);
    console.error('');
    console.error('MANUAL FALLBACK:');
    console.error('1. Open Chrome → chatgpt.com → log in');
    console.error('2. Open DevTools (F12) → Application → Cookies → chatgpt.com');
    console.error('3. Copy the value of "__Secure-next-auth.session-token"');
    console.error('4. Run: node manual_auth.js <paste-token-here>');
    process.exit(1);
  }
}

main();
