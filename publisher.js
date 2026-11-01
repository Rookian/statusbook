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
const { splitStatusText } = require('./public/textsplit.js');

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
  await closeTextEditor();
}

// ---------- text status ----------
// WhatsApp's own text status: text on a colored background, no picture. The editor has
// a text field ("Type a status") and the buttons Emoji, Font, Palette and Send.
const textBox = () => page.locator('[contenteditable="true"][aria-placeholder="Type a status"], [contenteditable="true"][data-placeholder="Type a status"]').first();
const closeTextButton = () => page.getByRole('button', { name: 'Close status posting view' });

// Closes the text status editor without sending; a question whether to discard the
// draft is answered with Discard (it is our own unsent draft).
async function closeTextEditor() {
  if (!(await closeTextButton().isVisible().catch(() => false))) return;
  await closeTextButton().click().catch(() => {});
  await page.waitForTimeout(400);
  const discard = page.getByRole('dialog').getByRole('button', { name: /^discard$/i });
  if (await discard.isVisible().catch(() => false)) await discard.click().catch(() => {});
  await page.waitForTimeout(300);
}

// The editor's background color right now: the first colored layer under the text field.
const editorColor = () => textBox().evaluate(el => {
  const r = el.getBoundingClientRect();
  for (const n of document.elementsFromPoint(r.left + 4, r.top + r.height / 2)) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
  }
  return null;
});

const rgbOf = c => {
  if (!c) return null;
  const hex = /^#?([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? [+m[1], +m[2], +m[3]] : null;
};
const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// WhatsApp only has its own set of backgrounds, and Palette picks one at random each
// click. So it clicks until the background is the known color closest to the post's
// color (all colors seen in this session count), at most 40 clicks.
const knownColors = new Set();
let lastColor = null;  // for tryTextStatus
async function setTextBackground(bg) {
  const want = rgbOf(bg);
  if (!want) return;
  const dist = c => { const rgb = rgbOf(c); return rgb ? colorDistance(rgb, want) : Infinity; };
  const closest = () => [...knownColors].reduce((a, c) => (dist(c) < dist(a) ? c : a), [...knownColors][0]);
  let cur = await editorColor();
  if (cur) knownColors.add(cur);
  for (let i = 0; i < 40; i++) {
    // Done when the background is the closest known color, unless few colors are known
    // yet and it is still far off (a closer one may not have shown up yet).
    if (cur === closest() && !(knownColors.size < 8 && dist(cur) > 60)) break;
    const before = cur;
    await page.getByRole('button', { name: 'Palette', exact: true }).click();
    for (let k = 0; k < 10; k++) {
      await page.waitForTimeout(60);
      cur = await editorColor();
      if (cur !== before) break;
    }
    if (cur) knownColors.add(cur);
  }
  lastColor = cur;
}

// One text status. dryRun: everything up to Send, then the editor is closed unsent.
async function postTextOne(text, bg, label, dryRun) {
  await clearDialogs();
  await closeTextEditor();
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await clearDialogs();
  await page.getByRole('button', { name: /^add status$/i }).click();
  await page.getByRole('menuitem', { name: 'Text', exact: true }).click();
  const box = textBox();
  await box.waitFor({ state: 'visible', timeout: 15000 });
  await setTextBackground(bg);
  // Pasted, so line breaks stay line breaks (Enter would send).
  await box.click();
  await box.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await page.waitForTimeout(300);
  const norm = t => t.replace(/\s+/g, ' ').trim();
  const typed = (await box.innerText()) || '';
  if (norm(typed) !== norm(text)) {
    await closeTextEditor();
    throw new Error(`The text of ${label} could not be entered completely (${norm(typed).length} of ${norm(text).length} characters)`);
  }
  const send = page.getByRole('button', { name: 'Send', exact: true });
  if (dryRun) {
    await send.waitFor({ state: 'visible', timeout: 10000 });
    await closeTextEditor();
    await box.waitFor({ state: 'detached', timeout: 15000 });
    return;
  }
  await send.click();
  await box.waitFor({ state: 'detached', timeout: 60000 });
  await waitUntil(async () => {
    const s = await myStatusText();
    return s && !/sending/i.test(s);
  }, 180000, `finish sending ${label}`);
}

// A text-only post (not a day intro, which has a map and stays a picture) goes out as
// text status(es); its caption, if any, is added as the last paragraph.
const isTextStatus = item => item.type === 'text' && !item.intro && typeof item.text === 'string';
const statusTexts = item => splitStatusText([item.text, item.caption].map(t => (t || '').trim()).filter(Boolean).join('\n\n'));

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
      if (isTextStatus(item)) {
        const texts = statusTexts(item);
        for (let i = 0; i < texts.length; i++) {
          await postTextOne(texts[i], item.bg, texts.length > 1 ? `${item.file} (${i + 1}/${texts.length})` : item.file, dryRun);
        }
      } else {
        await postOne(path.join(dir, item.file), item.caption, dryRun);
      }
    } catch (err) {
      await discardEditor();
      throw err;
    }
    await onPosted(item);
  }
  return { stopped: false };
}

// Development aid: opens the text status editor, reads how it is built (accessibility
// tree and the editor's HTML) and closes it again without sending anything.
async function inspectTextStatus() {
  if ((await loginState()) !== 'ready') throw new Error('WhatsApp Web is not signed in');
  const out = {};
  await clearDialogs();
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await clearDialogs();
  await page.getByRole('button', { name: /^add status$/i }).click();
  await page.waitForTimeout(800);
  out.menu = await page.getByRole('application').or(page.locator('body')).first().ariaSnapshot().catch(e => String(e));
  out.menuItems = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="menu"] li, [role="menu"] [role="button"]')]
    .map(n => (n.getAttribute('aria-label') || n.textContent || '').trim()).filter(Boolean));
  const textItem = page.getByRole('menuitem', { name: /^text$/i });
  if (!(await textItem.count())) { await page.keyboard.press('Escape'); out.note = 'no "Text" menu item'; return out; }
  await textItem.first().click();
  await page.waitForTimeout(1500);
  out.editor = await page.locator('body').ariaSnapshot().catch(e => String(e));
  out.html = await page.evaluate(() => {
    const ed = [...document.querySelectorAll('[contenteditable="true"]')].map(n => ({
      label: n.getAttribute('aria-label'), placeholder: n.getAttribute('aria-placeholder') || n.getAttribute('data-placeholder'),
      lexical: n.hasAttribute('data-lexical-editor'), tab: n.getAttribute('data-tab'),
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(b => b.offsetParent).map(b => ({
      label: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.textContent || '').trim().slice(0, 30),
      testid: b.getAttribute('data-testid'), icon: (b.querySelector('[data-icon]') || {}).getAttribute ? b.querySelector('[data-icon]').getAttribute('data-icon') : null,
    }));
    const big = [...document.querySelectorAll('div')].filter(d => {
      const c = getComputedStyle(d).backgroundColor, r = d.getBoundingClientRect();
      return r.width > 300 && r.height > 300 && c && c !== 'rgba(0, 0, 0, 0)';
    }).map(d => ({ bg: getComputedStyle(d).backgroundColor, w: Math.round(d.getBoundingClientRect().width), h: Math.round(d.getBoundingClientRect().height), cls: d.className.slice(0, 40) })).slice(-8);
    return { editables: ed, buttons, colored: big };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  // Escape may first ask whether to discard the draft.
  out.afterEscape = await page.locator('[role="dialog"]').first().innerText().catch(() => null);
  await clearDialogs();
  return out;
}

// Development aid: goes through a text post's statuses up to Send and closes the editor
// each time. Never sends.
async function tryTextStatus(text, bg) {
  if ((await loginState()) !== 'ready') throw new Error('WhatsApp Web is not signed in');
  const texts = statusTexts({ type: 'text', text, caption: '' });
  const out = [];
  try {
    for (let i = 0; i < texts.length; i++) {
      await postTextOne(texts[i], bg, `try ${i + 1}/${texts.length}`, true);
      out.push({ chars: texts[i].length, ok: true });
    }
  } catch (err) {
    await discardEditor();
    out.push({ error: err.message });
  }
  return { statuses: out, colors: [...knownColors], chosen: lastColor };
}

async function close() {
  if (context) await context.close().catch(() => {});
  context = null;
  page = null;
}

module.exports = { open, loginState, publish, close, findBrowser, inspectTextStatus, tryTextStatus, statusTexts, isTextStatus, lastDialogText: () => lastDialog };
