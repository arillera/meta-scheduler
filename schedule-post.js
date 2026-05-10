#!/usr/bin/env node
// meta-scheduler — Made by Antonio Automates and Claude to help you get your time back.
// MIT licensed. See LICENSE.

import { chromium } from 'playwright';
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { loadAccount, dayPaths } from './lib/account.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    account:    { type: 'string', default: process.env.META_SCHEDULER_ACCOUNT || 'default' },
    day:        { type: 'string' },
    images:     { type: 'string' },
    caption:    { type: 'string' },
    'caption-start-line': { type: 'string' },
    datetime:   { type: 'string' },
    page:       { type: 'string' },
    setup:      { type: 'boolean', default: false },
    'dry-run':  { type: 'boolean', default: false },
    headless:   { type: 'boolean', default: false },
    help:       { type: 'boolean', default: false },
  },
});

const account = loadAccount(values.account);
const config = {
  pageName: values.page || account.pageName,
  composerUrl: account.composerUrl,
  businessSuiteUrl: account.businessSuiteUrl,
};

if (values.help || (!values.setup && (!values.day && !values.images))) {
  console.log(`
Usage:
  node schedule-post.js --account <name> --setup
      First-run login for an account. Opens browser, you log in once.

  node schedule-post.js --account <name> --day NN --datetime "YYYY-MM-DD HH:MM" [--dry-run]
      Schedule Day-NN. Asset paths come from accounts/<name>.json.

  node schedule-post.js --account <name> --images <dir> --caption <file> --datetime <ISO> [--dry-run]
      Manual mode for ad-hoc posts.

Flags:
  --account NAME           Account config from accounts/<NAME>.json (or set META_SCHEDULER_ACCOUNT env var).
  --caption-start-line N   Override caption-start-line for this run.
  --page "Name"            Override Page name for this run.
  --dry-run                Do everything except click Schedule.
  --headless               Run without a visible browser window.
  --help                   Print this help.
`);
  process.exit(0);
}

const profileDir = account.profileDir;
const screenshotsDir = account.screenshotsDir;

// Clean stale lock files left by crashed prior runs (otherwise Chromium aborts on startup).
for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  const p = join(profileDir, lock);
  try { if (existsSync(p)) unlinkSync(p); } catch {}
}

function resolveFromDay(dayStr) {
  const { imagesDir, captionFile } = dayPaths(account, dayStr);
  return { imagesDir, captionFile };
}

function extractCaption(filePath, startLine) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const slice = lines.slice(startLine - 1);
  // Stop at first markdown separator '---' or end of file
  const cutIdx = slice.findIndex((l) => l.trim() === '---');
  const captionLines = cutIdx === -1 ? slice : slice.slice(0, cutIdx);
  // Trim trailing blank lines
  while (captionLines.length && captionLines[captionLines.length - 1].trim() === '') {
    captionLines.pop();
  }
  return captionLines.join('\n');
}

function listSlides(dir) {
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function validateDatetime(s) {
  // Accept "YYYY-MM-DD HH:MM" in local time
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`--datetime must be "YYYY-MM-DD HH:MM" (got "${s}")`);
  const [, Y, M, D, h, mn] = m.map(Number);
  const target = new Date(Y, M - 1, D, h, mn, 0, 0);
  const now = new Date();
  const minMs = 20 * 60 * 1000;
  const maxMs = 29 * 24 * 60 * 60 * 1000;
  const delta = target - now;
  if (delta < minMs) throw new Error(`Scheduled time must be ≥20 minutes from now (got ${(delta / 60000).toFixed(1)} min).`);
  if (delta > maxMs) throw new Error(`Scheduled time must be ≤29 days from now.`);
  return { date: target, dayInt: D, monthInt: M, yearInt: Y, hourInt: h, minuteInt: mn };
}

async function setup() {
  console.log(`[setup] Launching browser with profile at ${profileDir}`);
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(config.businessSuiteUrl);
  console.log(`
[setup] Browser is open. Please:
  1. Log into Meta Business Suite.
  2. Confirm the top-left switcher shows the business that owns "${account.pageName}".
  3. Close the browser window when you're done — your login will be saved.
`);
  await ctx.waitForEvent('close', { timeout: 0 });
  console.log('[setup] Profile saved. Future runs will reuse this login.');
}

async function findCaptionField(page) {
  const candidates = [
    () => page.getByRole('textbox', { name: /text/i }).first(),
    () => page.getByRole('textbox', { name: /what.s on your mind/i }).first(),
    () => page.getByRole('textbox', { name: /caption/i }).first(),
    () => page.getByRole('textbox', { name: /write/i }).first(),
    () => page.locator('[contenteditable="true"][role="textbox"]').first(),
    () => page.locator('div[contenteditable="true"]').first(),
  ];
  for (const make of candidates) {
    const loc = make();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      return loc;
    } catch {}
  }
  throw new Error('Could not find caption field.');
}

async function pasteCaption(page, caption) {
  const field = await findCaptionField(page);
  await field.click();
  await page.waitForTimeout(300);
  await page.keyboard.insertText(caption);
  await page.waitForTimeout(500);
}

async function trySetInputFiles(page, slidePaths, label) {
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) return false;
  for (let i = 0; i < count; i++) {
    try {
      await inputs.nth(i).setInputFiles(slidePaths);
      console.log(`[upload] setInputFiles fired on input #${i}${label ? ` (${label})` : ''}`);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function debugInputs(page, label) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  console.log(`[upload] [${label}] file inputs in DOM: ${n}`);
  for (let i = 0; i < n; i++) {
    const accept = await inputs.nth(i).getAttribute('accept').catch(() => '');
    const multi = await inputs.nth(i).getAttribute('multiple').catch(() => null);
    console.log(`[upload] [${label}]   #${i} accept="${accept}" multiple=${multi !== null}`);
  }
}

async function clickAddTrigger(page, isFirst) {
  // First slide: "Add photo" button. Subsequent: composer-internal "+" / "Add more".
  const candidates = isFirst
    ? [
        page.getByRole('button', { name: /^add\s*photo/i }),
        page.getByRole('button', { name: /add\s*photo\s*\/\s*video/i }),
      ]
    : [
        page.getByRole('button', { name: /add\s*more/i }),
        page.getByRole('button', { name: /^\+/ }),
        page.getByLabel(/add (more|another) (photo|media|image)/i),
        // Sometimes the original Add photo button still works to append
        page.getByRole('button', { name: /^add\s*photo/i }),
      ];
  for (const loc of candidates) {
    const f = loc.first();
    if (await f.count().catch(() => 0)) {
      await f.click();
      console.log(`[upload] clicked add-trigger (${isFirst ? 'first' : 'subsequent'})`);
      return true;
    }
  }
  return false;
}

async function uploadOne(page, slidePath, idx, total) {
  const label = `slide ${idx + 1}/${total}`;
  console.log(`[upload] ${label}: ${slidePath.split('/').pop()}`);

  // Pre-flight: input may already be mounted; setInputFiles replaces selection,
  // so this only works for the first slide. After that, we need the dropdown.
  if (idx === 0 && (await trySetInputFiles(page, [slidePath], `${label} pre-dropdown`))) {
    await page.waitForTimeout(2500);
    return;
  }

  if (!(await clickAddTrigger(page, idx === 0))) {
    throw new Error(`Could not find an "Add photo" / "Add more" button for ${label}`);
  }
  await page.waitForTimeout(900);

  // After dropdown opens, file input may mount. Try setInputFiles on it directly.
  if (await trySetInputFiles(page, [slidePath], `${label} post-dropdown`)) {
    await page.waitForTimeout(2500);
    return;
  }

  // Snapshot current state at probe time so we can see what the DOM actually has.
  const probeShot = join(screenshotsDir, `probe-${Date.now()}.png`);
  await page.screenshot({ path: probeShot, fullPage: false }).catch(() => {});
  console.log(`[upload] probe snapshot: ${probeShot}`);

  // Probe document + all iframes for ANY element whose textContent contains the phrase.
  const probe = await page.evaluate(() => {
    function walk(root, out, depth = 0) {
      if (depth > 8 || out.length > 20) return;
      const tw = root.querySelectorAll('*');
      for (const el of tw) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (/^upload from desktop$/i.test(txt) || (/upload from desktop/i.test(txt) && el.children.length < 4)) {
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            kids: el.children.length,
            classes: (el.className || '').toString().slice(0, 60),
            text: txt.slice(0, 60),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          });
          if (out.length > 20) return;
        }
      }
    }
    const out = [];
    walk(document, out);
    for (const f of document.querySelectorAll('iframe')) {
      try { walk(f.contentDocument, out); } catch {}
    }
    return { matches: out, frames: document.querySelectorAll('iframe').length };
  });
  console.log(`[upload] probe iframes=${probe.frames} matches=${probe.matches.length}: ${JSON.stringify(probe.matches.slice(0, 4))}`);

  // Click via getByText. We click the leaf-text element; Playwright climbs to a clickable ancestor.
  const uploadItem = page.getByText('Upload from desktop', { exact: false }).first();
  const chooserP = page
    .waitForEvent('filechooser', { timeout: 10000 })
    .then((c) => ({ kind: 'chooser', c }))
    .catch(() => null);
  await uploadItem.click();
  await page.waitForTimeout(400);

  // Some Meta pages mount a hidden input on click instead of opening native picker.
  if (await trySetInputFiles(page, [slidePath], `${label} post-click`)) {
    await page.waitForTimeout(2500);
    return;
  }

  const result = await chooserP;
  if (result && result.kind === 'chooser') {
    await result.c.setFiles([slidePath]);
    console.log(`[upload] ${label}: setFiles via filechooser`);
    await page.waitForTimeout(2500);
    return;
  }

  throw new Error(`Upload failed for ${label}: no filechooser, no file input mounted.`);
}

async function uploadSlides(page, slidePaths) {
  console.log(`[upload] Uploading ${slidePaths.length} slides one-by-one…`);
  await debugInputs(page, 'initial');
  for (let i = 0; i < slidePaths.length; i++) {
    await uploadOne(page, slidePaths[i], i, slidePaths.length);
  }
  console.log('[upload] All slides submitted. Allowing thumbnails to settle…');
  await page.waitForTimeout(3000);
}

async function ensurePostToChecked(page) {
  // Look for checkboxes labelled with the page name and Instagram.
  // Don't fail hard — just log what we see.
  const checkboxes = page.getByRole('checkbox');
  const n = await checkboxes.count();
  console.log(`[post-to] Found ${n} checkboxes; verifying both FB + IG are checked.`);
  for (let i = 0; i < n; i++) {
    const cb = checkboxes.nth(i);
    const label = (await cb.getAttribute('aria-label').catch(() => '')) || '';
    const checked = await cb.isChecked().catch(() => null);
    if (/facebook|instagram/i.test(label) && checked === false) {
      console.log(`[post-to] checking: ${label}`);
      await cb.check().catch(() => {});
    }
  }
}

async function probeScheduleRegion(page) {
  const data = await page.evaluate(() => {
    const interactive = ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'];
    const out = [];
    const items = document.querySelectorAll('*');
    for (const el of items) {
      const tag = el.tagName;
      const role = el.getAttribute('role');
      const isInteractive =
        interactive.includes(tag) ||
        (role && /button|combobox|spinbutton|textbox|switch|listbox|option|menuitem/.test(role)) ||
        el.getAttribute('contenteditable') === 'true';
      if (!isInteractive) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      out.push({
        tag,
        role,
        type: el.getAttribute('type'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder'),
        value: el.value,
        text: txt,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      });
    }
    // Sort by y (top to bottom)
    out.sort((a, b) => a.y - b.y);
    return out;
  });
  return data;
}

function format12hr(hour24) {
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return { hour12: h, meridiem };
}

function formatDateForInput(date) {
  // Meta's date input shows "May 11, 2026" but accepts typed input as MM/DD/YYYY.
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function dateReadbackCandidates(date) {
  // Meta uses short month names ("Jun 1, 2026") for some months and long ("May 11, 2026") for others.
  // Accept either as valid for the readback check.
  const day = date.getDate();
  const year = date.getFullYear();
  const longMonth = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(date);
  const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date);
  return [
    `${longMonth} ${day}, ${year}`,
    `${shortMonth} ${day}, ${year}`,
  ];
}

async function setRowDate(page, rowIndex, dateString, expectedReadbacks) {
  // Date inputs are <input> elements whose `value` matches "Month D, YYYY"
  const handles = await page.evaluateHandle(() => {
    const matches = [];
    for (const el of document.querySelectorAll('input')) {
      if (typeof el.value === 'string' && /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(el.value)) {
        matches.push(el);
      }
    }
    return matches;
  });
  const props = await handles.getProperties();
  const arr = [];
  for (const p of props.values()) arr.push(p.asElement());
  if (arr.length <= rowIndex || !arr[rowIndex]) {
    throw new Error(`No date input found for row ${rowIndex} (saw ${arr.length}).`);
  }
  const target = arr[rowIndex];

  // Click + select-all + type MM/DD/YYYY. Press Tab to commit and defocus.
  await target.click();
  await page.waitForTimeout(150);
  await target.press('Meta+a').catch(() => {});
  await page.waitForTimeout(80);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
  await page.keyboard.type(dateString, { delay: 30 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);

  const after = await target.evaluate((el) => el.value);
  const acceptable = Array.isArray(expectedReadbacks) ? expectedReadbacks : [expectedReadbacks];
  if (!acceptable.includes(after)) {
    throw new Error(`Date input row ${rowIndex} did not commit; expected one of ${JSON.stringify(acceptable)}, got "${after}".`);
  }
}

async function setTimeOnRow(page, rowIndex, hour24, minute) {
  const { hour12, meridiem } = format12hr(hour24);
  const hourFields = page.locator('input[role="spinbutton"][aria-label="hours"]');
  const minuteFields = page.locator('input[role="spinbutton"][aria-label="minutes"]');
  const meridiemFields = page.locator('input[role="spinbutton"][aria-label="meridiem"]');

  const h = hourFields.nth(rowIndex);
  const m = minuteFields.nth(rowIndex);
  const am = meridiemFields.nth(rowIndex);

  await h.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(hour12).padStart(2, '0'));

  await m.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(minute).padStart(2, '0'));

  await am.click();
  // Meridiem spinbutton accepts a single character: 'A' or 'P'
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(meridiem.charAt(0));
}

async function probeDateRegion(page) {
  return await page.evaluate(() => {
    const out = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.y < 580 || r.y > 770 || r.width === 0 || r.height === 0) continue;
      const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label') || '';
      const dateInText = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{1,2},?\s*\d{4}/i.test(txt) ||
                         /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(txt);
      const isInteractive =
        ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(el.tagName) ||
        ['button', 'combobox', 'spinbutton', 'textbox', 'switch', 'link'].includes(role);
      // Only capture leaf-ish or modest containers when they have date text;
      // capture ALL interactive elements regardless of children
      if (!isInteractive && !dateInText) continue;
      if (dateInText && el.children.length > 4) continue;
      out.push({
        tag: el.tagName,
        role,
        ariaLabel: aria || null,
        type: el.getAttribute('type'),
        value: el.value,
        text: txt.slice(0, 80),
        kids: el.children.length,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
      });
      if (out.length > 100) break;
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return out;
  });
}

async function setSchedule(page, dt) {
  console.log('[schedule] Toggling Set date and time…');
  const toggle = page.getByRole('switch', { name: /set date and time/i }).first();
  if (await toggle.count()) {
    const checked = await toggle.getAttribute('aria-checked');
    if (checked !== 'true') await toggle.click();
  } else {
    const alt = page.getByText(/set date and time/i).first();
    if (await alt.count()) await alt.click();
  }
  await page.waitForTimeout(1500);

  const stamp = Date.now();
  const shotPath = join(screenshotsDir, `schedule-region-${stamp}.png`);
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
  console.log(`[schedule] full-page snapshot: ${shotPath}`);

  const dateTyped = formatDateForInput(dt.date);
  const dateExpect = dateReadbackCandidates(dt.date);
  const hourCount = await page.locator('input[role="spinbutton"][aria-label="hours"]').count();
  console.log(`[schedule] Found ${hourCount} schedule rows. Typing "${dateTyped}" → expect one of ${JSON.stringify(dateExpect)}, ${dt.hourInt}:${String(dt.minuteInt).padStart(2, '0')}…`);
  if (hourCount === 0) throw new Error('No hours spinbutton found — schedule UI structure may have changed.');
  for (let i = 0; i < hourCount; i++) {
    await setRowDate(page, i, dateTyped, dateExpect);
    await setTimeOnRow(page, i, dt.hourInt, dt.minuteInt);
    console.log(`[schedule] Row ${i} date+time set.`);
  }
  await page.waitForTimeout(800);
}

async function clickSchedule(page) {
  const btn = page.getByRole('button', { name: /^schedule$/i }).first();
  await btn.click();
  await page.waitForTimeout(2500);
}

async function run() {
  if (values.setup) {
    await setup();
    return;
  }

  const { day, images, caption: captionArg, datetime } = values;
  if (!datetime) throw new Error('--datetime is required.');
  const dt = validateDatetime(datetime);

  let imagesDir, captionFile;
  if (day) {
    ({ imagesDir, captionFile } = resolveFromDay(day));
  } else {
    imagesDir = resolve(images);
    captionFile = resolve(captionArg);
  }
  if (!existsSync(imagesDir)) throw new Error(`Images dir not found: ${imagesDir}`);
  if (!existsSync(captionFile)) throw new Error(`Caption file not found: ${captionFile}`);

  const captionStartLine = values['caption-start-line']
    ? parseInt(values['caption-start-line'], 10)
    : (account.captionStartLine || 5);
  const caption = extractCaption(captionFile, captionStartLine);
  const slides = listSlides(imagesDir);
  if (slides.length === 0) throw new Error(`No slides in ${imagesDir}`);

  console.log(`
[plan]
  Account:   ${account.name} (${account.displayName})
  Day:       ${day || '(manual)'}
  Images:    ${slides.length} files from ${imagesDir}
             ${slides.map((s) => '  - ' + s.split('/').pop()).join('\n')}
  Caption:   ${caption.length} chars from ${captionFile}
  Datetime:  ${dt.date.toString()}
  Page:      ${config.pageName}
  Mode:      ${values['dry-run'] ? 'DRY RUN (no Schedule click)' : 'LIVE'}
`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: !!values.headless,
    viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    console.log('[nav] Opening composer…');
    await page.goto(config.composerUrl, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 });
    } catch {
      console.log('[nav] networkidle wait timed out (continuing)');
    }
    await page.waitForTimeout(2000);

    const navStamp = Date.now();
    const navShot = join(screenshotsDir, `nav-${navStamp}.png`);
    await page.screenshot({ path: navShot, fullPage: false }).catch(() => {});
    console.log(`[nav] URL after load: ${page.url()}`);
    console.log(`[nav] Snapshot: ${navShot}`);

    console.log('[caption] Pasting caption…');
    await pasteCaption(page, caption);

    await uploadSlides(page, slides);
    console.log('[upload] Waiting for thumbnails to finalize…');
    await page.waitForTimeout(8000);

    await ensurePostToChecked(page);

    await setSchedule(page, dt);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = join(screenshotsDir, `${day ? `day-${String(day).padStart(2, '0')}` : 'manual'}-${stamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[screenshot] ${screenshotPath}`);

    if (values['dry-run']) {
      console.log('[dry-run] Stopping before Schedule click. Inspect the browser, then close.');
      await ctx.waitForEvent('close', { timeout: 0 });
      return;
    }

    console.log('[schedule] Clicking Schedule…');
    await clickSchedule(page);
    const after = join(screenshotsDir, `${day ? `day-${String(day).padStart(2, '0')}` : 'manual'}-${stamp}-after.png`);
    await page.screenshot({ path: after, fullPage: true });
    console.log(`[done] Post-schedule screenshot: ${after}`);
  } catch (err) {
    const errPath = join(screenshotsDir, `error-${Date.now()}.png`);
    await page.screenshot({ path: errPath, fullPage: true }).catch(() => {});
    console.error(`[error] ${err.message}`);
    console.error(`[error] Screenshot: ${errPath}`);
    throw err;
  } finally {
    if (!values['dry-run']) await ctx.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
