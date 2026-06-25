/**
 * manual_auth.js — Manually build auth.json from Chrome DevTools cookies
 *
 * This is the MOST RELIABLE method when automated browser launch fails.
 *
 * Steps:
 *   1. Open Chrome → go to https://chatgpt.com → make sure you're logged in
 *   2. Press F12 → Application tab → Cookies → https://chatgpt.com
 *   3. Find the cookie named: __Secure-next-auth.session-token
 *   4. Copy its VALUE (the long string)
 *   5. Run: node manual_auth.js
 *      (The script will prompt you to paste it)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_FILE = path.join(__dirname, 'auth.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Manual Cookie Auth Setup');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
  console.log('STEPS:');
  console.log('  1. Open Chrome');
  console.log('  2. Go to: https://chatgpt.com');
  console.log('  3. Make sure you are LOGGED IN as madhavkalra2005@gmail.com');
  console.log('  4. Press F12 (DevTools)');
  console.log('  5. Click "Application" tab (top bar)');
  console.log('  6. In left sidebar: Storage → Cookies → https://chatgpt.com');
  console.log('  7. Find cookie named: __Secure-next-auth.session-token');
  console.log('  8. Click on it and copy the full VALUE from the bottom panel');
  console.log('');

  const token = await ask('Paste the __Secure-next-auth.session-token value here:\n> ');

  if (!token || token.trim().length < 20) {
    console.error('❌ Invalid token — too short. Please try again.');
    rl.close();
    process.exit(1);
  }

  console.log('');
  const oaiSc = await ask('(Optional) Paste the "oai-sc" cookie value (or press Enter to skip):\n> ');
  const cfClearance = await ask('(Optional) Paste the "cf_clearance" cookie value (or press Enter to skip):\n> ');

  rl.close();

  // Build auth.json in Playwright format
  const oneYearFromNow = (Date.now() / 1000) + 365 * 24 * 3600;

  const cookies = [
    {
      name: '__Secure-next-auth.session-token',
      value: token.trim(),
      domain: '.chatgpt.com',
      path: '/',
      expires: oneYearFromNow,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    }
  ];

  if (oaiSc && oaiSc.trim().length > 5) {
    cookies.push({
      name: 'oai-sc',
      value: oaiSc.trim(),
      domain: '.chatgpt.com',
      path: '/',
      expires: oneYearFromNow,
      httpOnly: false,
      secure: true,
      sameSite: 'None'
    });
  }

  if (cfClearance && cfClearance.trim().length > 5) {
    cookies.push({
      name: 'cf_clearance',
      value: cfClearance.trim(),
      domain: '.chatgpt.com',
      path: '/',
      expires: oneYearFromNow,
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    });
  }

  const authState = {
    cookies,
    origins: []
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authState, null, 2), 'utf-8');

  console.log('');
  console.log(`✅ auth.json saved with ${cookies.length} cookie(s):`);
  cookies.forEach(c => console.log(`   ✓ ${c.name}`));
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Now run the scraper:');
  console.log('  npm start          → process all prompts');
  console.log('  npm test           → dry run first (2 prompts)');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
