'use strict';
// Publishes the files of a release part to WhatsApp Status through WhatsApp Web, in a
// separate Chrome window controlled with Playwright. That window has its own profile
// (whatsapp-profile\ next to the app), so you sign in once with the QR code and stay
// signed in. Everything is found by WhatsApp Web's own button names, not by screen
// positions. Posts go out one by one, in order; each is reported as soon as WhatsApp
// has sent it, so an interrupted run can continue where it stopped.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME_PATHS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

let context = null;
let page = null;

const findBrowser = () => CHROME_PATHS.find(p => p && fs.existsSync(p)) || null;

// Opens (or brings back) the WhatsApp window.
async function open(profileDir) {
  if (page && !page.isClosed()) {
    await page.bringToFront().catch(() => {});
    return;
  }
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('Google Chrome (or Microsoft Edge) was not found.');
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath, headless: false, viewport: null, args: ['--start-maximized'],
  });
  context.on('close', () => { context = null; page = null; });
  page = context.pages()[0] || await context.newPage();
  await page.goto('https://web.whatsapp.com');
}

// "closed", "loading", "signin" (QR code shown) or "ready".
async function loginState() {
  if (!page || page.isClosed()) return 'closed';
  try {
    if (await page.getByRole('button', { name: 'Status', exact: true }).isVisible()) return 'ready';
    if (await page.locator('canvas[aria-label*="QR" i], [data-ref] canvas').first().isVisible()) return 'signin';
  } catch { /* page is navigating */ }
  return 'loading';
}

// WhatsApp shows notices over the page now and then (e.g. right after signing in:
// welcome, notifications). They block clicks, so they are closed first, but only with
// harmless buttons, or Escape. Never anything like "Log out" or "Delete".
const SAFE_DIALOG_BUTTONS = /^(ok|okay|got it|continue|not now|close|skip|dismiss|later|maybe later|no thanks|cancel)$/i;
let lastDialog = null;

async function clearDialogs() {
  for (let i = 0; i < 4; i++) {
    const dialog = page.locator('[role="dialog"][aria-modal="true"], [role="dialog"]:has(button)').first();
    if (!(await dialog.isVisible().catch(() => false))) return;
    lastDialog = ((await dialog.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200);
    const buttons = dialog.getByRole('button');
    let clicked = false;
    for (let b = 0; b < await buttons.count(); b++) {
      const btn = buttons.nth(b);
      const name = ((await btn.getAttribute('aria-label')) || (await btn.innerText().catch(() => '')) || '').trim();
      if (SAFE_DIALOG_BUTTONS.test(name)) { await btn.click().catch(() => {}); clicked = true; break; }
    }
    if (!clicked) await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
  }
}

const myStatusText = () => page.evaluate(() => ((document.body.innerText.match(/My status\s*\n\s*([^\n]+)/) || [])[1] || ''));

async function waitUntil(test, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`WhatsApp did not ${what} within ${Math.round(timeoutMs / 1000)} s`);
    await page.waitForTimeout(500);
  }
}

// Closes a half-done edit screen without sending (used after an error).
async function discardEditor() {
  const caption = page.getByRole('textbox', { name: 'Add a caption' });
  if (await caption.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  }
}

// One post: Status → Add Status → Photos & videos → file → caption → send → wait until sent.
// dryRun: everything up to the send button, then the edit screen is closed unsent.
async function postOne(file, caption, dryRun) {
  await clearDialogs();
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await clearDialogs();
  // Exact name: the "My status" header row also mentions "Add status" in its name.
  await page.getByRole('button', { name: /^add status$/i }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByRole('menuitem', { name: 'Photos & videos' }).click(),
  ]);
  await chooser.setFiles(file);
  const box = page.getByRole('textbox', { name: 'Add a caption' });
  // WhatsApp silently refuses files it doesn't take (e.g. videos over ~10 MB): then
  // the edit screen never opens.
  await box.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
    throw new Error(`WhatsApp did not accept ${path.basename(file)} (too big or unsupported?)`);
  });
  if (caption) {
    // WhatsApp Web's caption field takes no line breaks (Enter sends): one line.
    const text = caption.replace(/\s*\n\s*/g, ' ').trim();
    await box.click();
    await page.keyboard.insertText(text);
    const typed = (await box.innerText()).trim();
    if (typed !== text) {
      await discardEditor();
      throw new Error(`The caption of ${path.basename(file)} could not be entered correctly`);
    }
  }
  const send = page.locator('[role="button"][aria-label^="Send"]');
  if (dryRun) {
    await send.waitFor({ state: 'visible', timeout: 10000 });
    await discardEditor();
    await box.waitFor({ state: 'detached', timeout: 15000 });
    return;
  }
  await send.click();
  await box.waitFor({ state: 'detached', timeout: 60000 });
  // Sent when "My status" no longer says "Sending…".
  await waitUntil(async () => {
    const s = await myStatusText();
    return s && !/sending/i.test(s);
  }, 180000, `finish sending ${path.basename(file)}`);
}

// items: [{ file, caption, key }] in posting order; onPosted(item) is awaited after each
// post; shouldStop() is checked between posts. dryRun: nothing is sent (for testing).
async function publish(items, dir, onPosted, shouldStop, dryRun = false) {
  if ((await loginState()) !== 'ready') throw new Error('WhatsApp Web is not signed in');
  for (const item of items) {
    if (shouldStop()) return { stopped: true };
    try {
      await postOne(path.join(dir, item.file), item.caption, dryRun);
    } catch (err) {
      await discardEditor();
      throw err;
    }
    await onPosted(item);
  }
  return { stopped: false };
}

async function close() {
  if (context) await context.close().catch(() => {});
  context = null;
  page = null;
}

module.exports = { open, loginState, publish, close, findBrowser, lastDialogText: () => lastDialog };
