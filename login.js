/**
 * login.js — Verifies ChatGPT session using your real Chrome profile.
 *
 * Uses: C:\Users\madha\AppData\Local\Google\Chrome\User Data\Default
 * (Already logged in to ChatGPT — no manual login needed)
 *
 * ⚠️  IMPORTANT: Close all Chrome windows before running this!
 *
 * Usage: npm run login
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Accept account number as argument: node login.js 2 → saves auth-2.json
const ACCOUNT_NUM = parseInt(process.argv[2] || '1', 10);
const AUTH_FILE = path.join(__dirname, `auth-${ACCOUNT_NUM}.json`);

// ⚠️  Each account gets its own chrome-profile directory to avoid conflicts
const CHROME_USER_DATA = path.join(__dirname, `chrome-profile-${ACCOUNT_NUM}`);
const CHROME_PROFILE   = 'Default';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(`  ChatGPT Login — Account ${ACCOUNT_NUM} → ${path.basename(AUTH_FILE)}`);
  console.log('══════════════════════════════════════════════════');
  console.log('');
  console.log(`📁 User Data : ${CHROME_USER_DATA}`);
  console.log(`   Profile   : ${CHROME_PROFILE}`);
  console.log('');

  // Check paths
  if (!fs.existsSync(CHROME_USER_DATA)) {
    console.log('📁 Creating local chrome-profile directory...');
    fs.mkdirSync(CHROME_USER_DATA, { recursive: true });
  }
  
  if (!fs.existsSync(CHROME_EXE)) {
    console.error(`❌ Chrome exe not found: ${CHROME_EXE}`);
    console.error(`Please update CHROME_EXE path in login.js to point to your Google Chrome executable.`);
    process.exit(1);
  }

  console.log('🚀 Launching Chrome with your profile...');

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
    console.error('❌ Failed to launch Chrome:', err.message);
    if (err.message.includes('already in use') || err.message.includes('lock')) {
      console.error('👉 The local chrome-profile directory is locked.');
      console.error('   Please close any other running scraper/login processes first.');
    }
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', () => {});

  console.log('🌐 Opening ChatGPT...');
  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('⚠️  Navigation note:', e.message);
  }

  await page.waitForTimeout(3000);

  // Check login state by checking cookies and DOM
  console.log('🔍 Checking login state...');
  
  let cookies = await context.cookies('https://chatgpt.com');
  let isLoggedIn = cookies.some(c => c.name === '__Secure-next-auth.session-token' && c.value && c.value.length > 10);

  // Fallback DOM check: if prompt textarea exists but login button is absent
  const checkDomLogin = async () => {
    try {
      const hasInput = await page.$('#prompt-textarea');
      if (!hasInput) return false;

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
      return !hasLoginBtn;
    } catch (_) {
      return false;
    }
  };

  if (!isLoggedIn) {
    const isDomLoggedIn = await checkDomLogin();
    if (isDomLoggedIn) {
      isLoggedIn = true;
    }
  }

  if (!isLoggedIn) {
    console.log('');
    console.log('⚠️  You are NOT logged in.');
    console.log('   Please click "Log in" or "Sign up" and complete sign-in in the browser window.');
    console.log('   Waiting up to 5 minutes for login...');
    console.log('');

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      
      cookies = await context.cookies('https://chatgpt.com');
      const hasSessionToken = cookies.some(c => c.name === '__Secure-next-auth.session-token' && c.value && c.value.length > 10);
      const isDomLoggedIn = await checkDomLogin();

      if (hasSessionToken || isDomLoggedIn) {
        console.log('\n✅ Login detected!');
        // Wait a small extra buffer to ensure all session cookies are flushed/saved
        await page.waitForTimeout(2000);
        isLoggedIn = true;
        break;
      }
      process.stdout.write('.');
    }
  } else {
    console.log('✅ Already logged in with your profile!');
  }

  if (!isLoggedIn) {
    console.error('\n❌ Login not completed within 5 minutes. Closing.');
    await context.close();
    process.exit(1);
  }

  // Save storage state
  await page.waitForTimeout(2000);
  await context.storageState({ path: AUTH_FILE });

  const saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  console.log(`\n💾 Saved ${saved.cookies.length} cookies to ${path.basename(AUTH_FILE)}`);
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Account ${ACCOUNT_NUM} saved. Next steps:`);
  console.log(`  Login more accounts : npm run login:2  (then :3, :4...)`);
  console.log(`  Test                : npm run parallel:test`);
  console.log(`  Run all             : npm run parallel`);
  console.log('══════════════════════════════════════════════════');
  console.log('');

  // Keep browser open so user can see it
  // They will close it manually before running scraper
  await context.close();
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  if (e.message.includes('already in use')) {
    console.error('👉 Close ALL Chrome windows first, then run: npm run login');
  }
  process.exit(1);
});
