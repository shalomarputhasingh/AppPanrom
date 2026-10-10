// End-to-end test: real backend (serving the built Studio) + real Chromium. Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import zlib from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const port = 8765;
const base = `http://127.0.0.1:${port}`;
const shots = process.env.E2E_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of readdirSync(dir).filter((n) => n.startsWith('chromium-'))) {
    const p = path.join(dir, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium found; set CHROMIUM_PATH');
}

const data = mkdtempSync(path.join(os.tmpdir(), 'apppanrom-e2e-'));
const server = spawn('python3', ['-m', 'uvicorn', 'apppanrom.main:create_app', '--factory', '--port', String(port), '--log-level', 'warning'], {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, APPANROM_DATA_DIR: data },
  stdio: 'inherit',
});

let failed = 0;
let curPage;
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; if (shots && curPage) await curPage.screenshot({ path: path.join(shots, 'FAIL.png') }).catch(() => undefined); console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); throw e; }
};
const shot = async (page, n) => { if (shots) await page.screenshot({ path: path.join(shots, n + '.png') }); };

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('backend did not start');
}

const setCode = async (page, code) => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(code);
};

let browser;
try {
  await waitHealthy();
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  curPage = page;
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(base);

  await step('dashboard shows empty state', async () => {
    await page.getByText('No projects yet').waitFor();
    await shot(page, '01-dashboard-empty');
  });
  await step('create a project and open workspace', async () => {
    await page.getByLabel('New project name').fill('E2E App');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('no-problems').waitFor({ state: 'attached' }).catch(() => undefined);
  });
  await step('live diagnostics: starter code has no problems', async () => {
    await page.getByTestId('tab-diagnostics').click();
    await page.getByTestId('no-problems').waitFor();
  });
  await step('Run renders the app in the phone and it is interactive', async () => {
    await page.getByTestId('run-btn').click();
    const frame = page.frameLocator('[data-testid=preview-frame]');
    await frame.getByText('Vanakkam Nanba!').waitFor();
    await frame.getByLabel('Un peru').fill('Shalom');
    await frame.getByRole('button', { name: 'Click Pannu' }).click();
    await frame.getByText('Vanakkam Shalom!').waitFor();
    await frame.getByRole('button', { name: 'OK' }).click();
    await frame.getByText('Clicks: 1').waitFor();
    await shot(page, '02-running');
    await page.getByRole('tab', { name: 'Console' }).click();
    await page.getByTestId('console').getByText('message: Vanakkam Shalom!').waitFor();
  });
  await step('syntax error: diagnostics with line/col, preview shows error state', async () => {
    await setCode(page, 'screen_uruvakku("home"):\n    titel("x")\n');
    await page.getByTestId('tab-diagnostics').click();
    await page.getByTestId('diagnostics').getByText(/Unknown function 'titel'/).waitFor();
    await page.getByTestId('diagnostics').getByText('main.apn:2:5').waitFor();
    await page.getByTestId('run-btn').click();
    await page.getByRole('alert').filter({ hasText: 'error' }).first().waitFor();
    await shot(page, '03-error');
  });
  await step('fix the code and run a styled two-screen app with navigation + storage', async () => {
    const code = `app_uruvakku("Nav")
function go():
    screen_ku_poo("two")
function back():
    screen_back_poo()
function save():
    data_save_pannu("v", "hello")
    toast_kaattu("saved")
screen_uruvakku("home"):
    screen_title("Home")
    center_ama(style={"gap": 12, "background": "#EEF2FF"}):
        title("Home", style={"text_color": "#4338CA", "font_size": 30})
        button("Next", click_pannumbodhu=go, style={"background": "#16A34A", "corner_radius": 20})
        button("Save", click_pannumbodhu=save)
        text_kaattu("stored=" + str(data_edu("v", "none")))
screen_uruvakku("two"):
    screen_title("Two")
    button("Back", click_pannumbodhu=back)
`;
    await setCode(page, code);
    await page.getByTestId('save-state').filter({ hasText: 'All changes saved' }).waitFor();
    await page.getByTestId('run-btn').click();
    const frame = page.frameLocator('[data-testid=preview-frame]');
    const next = frame.getByRole('button', { name: 'Next' });
    await next.waitFor();
    const bg = await next.evaluate((el) => getComputedStyle(el).backgroundColor);
    if (bg !== 'rgb(22, 163, 74)') throw new Error('style not applied: ' + bg);
    const other = await frame.getByRole('button', { name: 'Save' }).evaluate((el) => getComputedStyle(el).backgroundColor);
    if (other === bg) throw new Error('style leaked to another button');
    await frame.getByRole('button', { name: 'Save' }).click();
    await frame.getByText('stored=hello').waitFor();
    await next.click();
    const userBack = frame.locator('.ap-btn', { hasText: 'Back' });
    await userBack.waitFor();
    await frame.getByRole('button', { name: 'Back', exact: true }).first().waitFor();
    await shot(page, '04-navigation');
    await userBack.click();
    await frame.getByRole('button', { name: 'Next' }).waitFor();
    // preview storage survives restarting the app
    await page.getByRole('button', { name: 'Restart app' }).click();
    await frame.getByText('stored=hello').waitFor();
  });
  await step('Build APK: without an Android SDK it fails honestly, no download offered', async () => {
    await page.getByTestId('goto-build').click();
    await page.getByText('Android build tools not ready').waitFor();
    await page.getByTestId('build-btn').click();
    await page.getByTestId('build-status').filter({ hasText: 'Failed' }).waitFor({ timeout: 30000 });
    await page.getByTestId('build-log').getByText(/android_sdk/).waitFor();
    if (await page.getByTestId('download-btn').count()) throw new Error('download offered for a failed build');
    await shot(page, '05-build-failed');
  });
  await step('project and code persist across reload', async () => {
    await page.reload();
    await page.getByTestId('editor').waitFor();
    await page.locator('.cm-content').getByText('screen_ku_poo("two")').waitFor();
  });
  await step('settings validation', async () => {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Application ID').fill('Not Valid');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText(/Invalid application id/).waitFor();
    await page.getByLabel('Application ID').fill('com.e2e.app');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.').waitFor();
  });
  await step('rename and delete (with confirmation) from the dashboard', async () => {
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('Project name', { exact: true }).fill('Renamed App');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('heading', { name: 'Renamed App' }).waitFor();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByText('permanently deleted').waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('heading', { name: 'Renamed App' }).waitFor();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByText('No projects yet').waitFor();
  });
  await step('visual designer: drag, inspect, move, delete, new handler, new screen - code updates live', async () => {
    const code = () => page.locator('.cm-content').innerText();
    const waitCode = async (re, timeout = 8000) => {
      const end = Date.now() + timeout;
      let last = '';
      while (Date.now() < end) { last = await code(); if (re.test(last)) return last; await page.waitForTimeout(100); }
      throw new Error('code never matched ' + re + '\n--- code ---\n' + last);
    };
    await page.getByLabel('New project name').fill('Designer App');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('mode-design').click();
    const canvas = page.getByTestId('design-canvas');
    await canvas.getByText('Vanakkam Nanba!').waitFor();
    await shot(page, '07-designer');

    // 1. drag a Button from the palette onto the empty part of the screen -> code gains a button
    await page.getByTestId('palette-button').dragTo(canvas.locator('.ap-screen'), { targetPosition: { x: 150, y: 480 } });
    await waitCode(/button\("Button"\)\s*$/m);
    await canvas.getByRole('button', { name: 'Button', exact: true }).waitFor();

    // 2. select it on the canvas -> inspector; edit the text -> canvas and code change
    await canvas.locator('.ap-btn', { hasText: 'Button' }).last().click();
    await page.getByTestId('inspector').waitFor();
    if (!(await page.getByTestId('inspector-title').innerText()).includes('button')) throw new Error('inspector shows wrong component');
    const label = page.getByTestId('inspector').getByLabel('Label', { exact: true });
    await label.fill('Save');
    await label.press('Enter');
    await waitCode(/button\("Save"\)/);
    await canvas.locator('.ap-btn', { hasText: 'Save' }).waitFor();

    // 3. style via the inspector (hex field) -> code + canvas colour
    const bg = page.getByTestId('inspector').getByLabel('Background', { exact: true });
    await bg.fill('#16A34A');
    await bg.press('Enter');
    await waitCode(/button\("Save", style=\{"background": "#16A34A"\}\)/);
    const col = await canvas.locator('.ap-btn', { hasText: 'Save' }).evaluate((el) => getComputedStyle(el).backgroundColor);
    if (col !== 'rgb(22, 163, 74)') throw new Error('canvas colour not updated: ' + col);
    // invalid values are rejected and never written
    const fs = page.getByTestId('inspector').getByLabel('Corner radius', { exact: true });
    await fs.fill('9999');
    await fs.press('Enter');
    await page.getByTestId('inspector').getByRole('alert').filter({ hasText: /Invalid value for style/ }).waitFor();
    if (/9999/.test(await code())) throw new Error('invalid value was written to the code');

    // 3b. one-click presets, palette swatches, clear all (each is a single batched edit of the code)
    await page.getByTestId('preset-clay').click();
    await waitCode(/"clay": true/);
    const clayShadow = await canvas.locator('.ap-btn', { hasText: 'Save' }).evaluate((el) => getComputedStyle(el).boxShadow);
    if (!/inset/.test(clayShadow)) throw new Error('clay preset not rendered on the canvas: ' + clayShadow);
    await page.getByTestId('inspector').getByRole('button', { name: 'Clay pastels #FCA5A5' }).first().click();
    await waitCode(/"background": "#FCA5A5"/);
    await page.getByTestId('preset-outline').click();
    await waitCode(/"border_width": 2/);
    if (/"clay"/.test(await code())) throw new Error('outline preset should remove clay');
    await page.getByRole('button', { name: /Clear all styles/ }).click();
    await waitCode(/button\("Save"\)\s*$/m);
    await bg.fill('#16A34A'); // later steps expect the green button
    await bg.press('Enter');
    await waitCode(/button\("Save", style=\{"background": "#16A34A"\}\)/);

    // 4. new handler wired to the button; code shows the function
    const onClick = page.getByTestId('inspector').getByLabel('On click', { exact: true });
    await onClick.selectOption({ label: '＋ New handler…' });
    await page.getByLabel('New handler name').fill('save_it');
    await page.getByRole('button', { name: 'Create' }).click();
    await waitCode(/function save_it\(\):/);
    await waitCode(/button\("Save", click_pannumbodhu=save_it, style=/);

    // 5. drag the Save button above the title: reorder written to code
    await canvas.locator('.ap-btn', { hasText: 'Save' }).dragTo(canvas.locator('.ap-title'), { targetPosition: { x: 40, y: 3 } });
    await page.waitForFunction(() => {
      const t = document.querySelector('.cm-content').innerText;
      return t.indexOf('button("Save"') > 0 && t.indexOf('button("Save"') < t.indexOf('title("Vanakkam Nanba!"');
    });

    // 6. drop a Row container, then a Text into it (empty container accepts drops, summa placeholder is replaced)
    await page.getByTestId('palette-row_uruvakku').dragTo(canvas.locator('.ap-screen'), { targetPosition: { x: 150, y: 520 } });
    await waitCode(/row_uruvakku\(style=\{"gap": 8\}\):\s*\n\s*summa/);
    await canvas.locator('.ap-empty').waitFor();
    await page.getByTestId('palette-text_kaattu').dragTo(canvas.locator('.ap-empty'));
    const c2 = await waitCode(/row_uruvakku\(style=\{"gap": 8\}\):\s*\n\s*text_kaattu\("Text"\)/);
    if (/summa/.test(c2)) throw new Error('summa placeholder was not replaced');

    // 7. code -> canvas: typing in the editor updates the design without pressing Run
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n    text_kaattu("Typed in code")\n');
    await canvas.getByText('Typed in code').waitFor();

    // 8. keyboard delete of the selected canvas element
    await canvas.getByText('Typed in code').click();
    await page.getByTestId('inspector-title').filter({ hasText: 'text_kaattu' }).waitFor();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await canvas.getByText('Typed in code').click();
    await page.keyboard.press('Delete');
    await canvas.getByText('Typed in code').waitFor({ state: 'detached' });
    if (/Typed in code/.test(await code())) throw new Error('delete did not update code');

    // 9. outline selects, add screen, switch screen
    await page.getByTestId('toolbar-delete').waitFor();
    await page.getByRole('button', { name: '+ Screen' }).click();
    await page.getByLabel('New screen name').fill('details');
    await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await waitCode(/screen_uruvakku\("details"\):/);
    await page.getByTestId('screen-pick').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid=screen-pick]').value === 'details');
    await canvas.locator('.ap-empty').waitFor();
    await shot(page, '08-designer-after');

    // 10. errors in code freeze the designer with a clear message, and recover when fixed
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n    titel("oops")\n');
    await page.getByTestId('design-stale').waitFor();
    await page.getByTestId('palette-title').dragTo(canvas.locator('.ap-screen')).catch(() => undefined);
    if (/Title"\)\s*\n\s*titel/.test(await code())) throw new Error('designer edited stale code');
    await page.keyboard.press('Control+Z');
    await page.getByTestId('design-stale').waitFor({ state: 'detached' });

    // 11. the designed app really runs in the preview
    await page.getByTestId('mode-run').click();
    await page.getByTestId('run-btn').click();
    const frame = page.frameLocator('[data-testid=preview-frame]');
    await frame.getByRole('button', { name: 'Save' }).waitFor();
    await frame.getByRole('button', { name: 'Save' }).click();
    await frame.getByText('save_it was called').waitFor();
  });
  await step('settings: app icon upload/validation/remove; build tab: release disabled without a key, permissions listed', async () => {
    const crc = (buf) => { let c, crcv = 0xffffffff; for (const b of buf) { c = (crcv ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c; } return (crcv ^ 0xffffffff) >>> 0; };
    const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const makePng = (n) => {
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
      const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 4, 0x80)]);
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(n).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
    };
    await page.getByRole('tab', { name: 'Settings' }).click();
    const up = page.getByLabel('Upload app icon (PNG)');
    await up.setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: makePng(64) });
    await page.getByText(/Icon must be between 192x192/).waitFor();
    await up.setInputFiles({ name: 'ok.png', mimeType: 'image/png', buffer: makePng(256) });
    await page.getByText('Icon updated.').waitFor();
    await page.getByAltText('App icon preview').waitFor();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByText(/default Android icon will be used/).waitFor();
    await page.getByTestId('goto-build').click();
    await page.getByTestId('permissions').getByText(/none/).waitFor();
    if (!(await page.getByTestId('kind-release_aab').isDisabled())) throw new Error('release AAB selectable without a signing key');
    if (!(await page.getByTestId('kind-release_apk').isDisabled())) throw new Error('release APK selectable without a signing key');
    await page.getByText('Release signing is not set up').waitFor();
    await page.getByTestId('build-btn').getByText('Build Debug APK').waitFor();
  });
  await step('device features + permissions in the generated Android bundle (vibrate, clipboard)', async () => {
    const src = path.join(data, 'device.apn');
    writeFileSync(src, `function buzz():
    vibrate_pannu(120)
    clipboard_copy("hello " + "clip")
screen_uruvakku("home"):
    button("Buzz", click_pannumbodhu=buzz)
`);
    const out = path.join(data, 'android-device');
    const r = spawnSync('python3', ['-m', 'apppanrom.cli', 'android-project', src, out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    const manifest = readFileSync(path.join(out, 'app/src/main/AndroidManifest.xml'), 'utf8');
    if (!manifest.includes('android.permission.VIBRATE') || manifest.includes('INTERNET')) throw new Error('wrong permissions in manifest:\n' + manifest);
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
    }).listen(8798);
    try {
      const p3 = await browser.newPage();
      await p3.addInitScript(() => {
        window.__calls = [];
        Object.defineProperty(navigator, 'vibrate', { value: (ms) => { window.__calls.push(['vibrate', ms]); return true; }, configurable: true });
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__calls.push(['copy', t]); return Promise.resolve(); } }, configurable: true });
      });
      await p3.goto('http://127.0.0.1:8798/assets/www/index.html');
      await p3.getByRole('button', { name: 'Buzz' }).click();
      const calls = await p3.evaluate('window.__calls');
      if (JSON.stringify(calls) !== JSON.stringify([['vibrate', 120], ['copy', 'hello clip']])) throw new Error('unexpected device calls: ' + JSON.stringify(calls));
    } finally { srv.close(); }
  });
  await step('generated Android web bundle runs in Chromium (same CSP as the APK) incl. back handling', async () => {
    const out = path.join(data, 'android-project');
    const r = spawnSync('python3', ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'vanakkam.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
    }).listen(8799);
    try {
      const p2 = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const errs = [];
      p2.on('pageerror', (e) => errs.push(e.message));
      p2.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      await p2.goto('http://127.0.0.1:8799/assets/www/index.html');
      await p2.getByText('Vanakkam Nanba!').waitFor();
      await p2.getByLabel('Un peru').fill('Nanba');
      await p2.getByRole('button', { name: 'Click Pannu' }).click();
      await p2.getByRole('button', { name: 'OK' }).click();
      await p2.getByText('Button click count: 1').waitFor();
      await p2.getByRole('button', { name: 'About' }).click();
      await p2.getByText('Tanglish-la app panra language.').waitFor();
      if ((await p2.evaluate('window.__apBack()')) !== true) throw new Error('back handler did not consume back press on 2nd screen');
      await p2.getByRole('button', { name: 'About' }).waitFor();
      if ((await p2.evaluate('window.__apBack()')) !== false) throw new Error('back handler should let Android finish on the first screen');
      await shot(p2, '06-android-bundle');
      if (errs.length) throw new Error('console errors in bundle: ' + errs.join('; '));
    } finally { srv.close(); }
  });
  await step('claymorphism calculator: clay shadows computed in Chromium, calculations work, pressed state', async () => {
    const out = path.join(data, 'calc-project');
    const r = spawnSync('python3', ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'calculator.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
    }).listen(8798);
    try {
      const p3 = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const errs = [];
      p3.on('pageerror', (e) => errs.push(e.message));
      await p3.goto('http://127.0.0.1:8798/assets/www/index.html');
      const btn = p3.getByRole('button', { name: '7', exact: true });
      await btn.waitFor();
      const shadow = await btn.evaluate((el) => getComputedStyle(el).boxShadow);
      if (!/inset/.test(shadow) || (shadow.match(/rgba?\(/g) || []).length < 3) throw new Error('clay box-shadow missing: ' + shadow);
      const radius = await btn.evaluate((el) => getComputedStyle(el).borderRadius);
      if (radius !== '28px') throw new Error('corner radius ' + radius);
      for (const k of ['6', 'x', '7', '=']) await p3.getByRole('button', { name: k, exact: true }).click();
      await p3.getByText('42', { exact: true }).waitFor();
      const box = await btn.boundingBox();
      await p3.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p3.mouse.down();
      const pressed = await btn.evaluate((el) => getComputedStyle(el).transform);
      await p3.mouse.up();
      if (pressed === 'none') throw new Error('no pressed transform on clay button');
      await shot(p3, '07-clay-calculator');
      if (errs.length) throw new Error('page errors: ' + errs.join('; '));
    } finally { srv.close(); }
  });
  await step('looks (glass, brutal, soft UI, gradient), animation and DOM patching in Chromium', async () => {
    const serve = async (example, port) => {
      const out = path.join(data, 'proj-' + example);
      const r = spawnSync('python3', ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', example + '.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
      if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
      const www = path.join(out, 'app/src/main/assets/www');
      return createServer((req, res) => {
        const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
        try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
      }).listen(port);
    };
    const srv = await serve('showcase', 8797);
    try {
      const p4 = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errs = [];
      p4.on('pageerror', (e) => errs.push(e.message));
      await p4.goto('http://127.0.0.1:8797/assets/www/index.html');
      await p4.getByText('Frosted, translucent, blurred backdrop').waitFor();
      const cs = (text, prop) => p4.getByText(text, { exact: true }).locator('xpath=ancestor-or-self::*[contains(@class,"ap-card")][1]').evaluate((el, pr) => getComputedStyle(el)[pr], prop);
      const glass = await cs('Frosted, translucent, blurred backdrop', 'backdropFilter');
      if (!/blur/.test(glass)) throw new Error('glass: no backdrop blur: ' + glass);
      const brutal = await p4.getByText('Thick outline, hard shadow', { exact: true }).locator('xpath=ancestor::*[contains(@class,"ap-card")][1]').evaluate((el) => { const c = getComputedStyle(el); return c.borderTopWidth + '|' + c.boxShadow; });
      if (!/^3px\|.*5px 5px 0px/.test(brutal)) throw new Error('brutal style wrong: ' + brutal);
      const neu = await cs('Neumorphism - same colour as the surface', 'boxShadow');
      if ((neu.match(/rgba?\(/g) || []).length < 2) throw new Error('soft UI shadows missing: ' + neu);
      const bgimg = await p4.locator('.ap-screen').evaluate((el) => getComputedStyle(el).backgroundImage);
      if (!/linear-gradient/.test(bgimg)) throw new Error('screen gradient missing: ' + bgimg);
      const anim = await p4.getByRole('button', { name: 'Glass', exact: true }).evaluate((el) => getComputedStyle(el).animationName);
      if (anim !== 'ap-pop') throw new Error('animation not applied: ' + anim);
      // patching: tapping a button updates the label but keeps the very same DOM node (no rebuild -> no animation restart)
      const tapBtn = p4.getByRole('button', { name: /^Tapped:/ });
      await tapBtn.evaluate((el) => { window.__keep = el; });
      await tapBtn.click({ force: true }); // an infinitely pulsing element is never 'stable' for Playwright
      await p4.getByRole('button', { name: 'Tapped: 1' }).waitFor();
      if (!(await p4.evaluate(() => document.querySelector('[data-aps^="b:tap"].ap-a-pulse') === window.__keep))) throw new Error('DOM node was rebuilt instead of patched');
      await p4.waitForTimeout(1800); // let the staggered entrance animations finish
      await shot(p4, '08-showcase');
      if (errs.length) throw new Error('page errors: ' + errs.join('; '));
    } finally { srv.close(); }
    // patching keeps focus and caret while typing (the old renderer re-created the input on every keystroke)
    const srv2 = await serve('vanakkam', 8796);
    try {
      const p5 = await browser.newPage({ viewport: { width: 390, height: 800 } });
      await p5.goto('http://127.0.0.1:8796/assets/www/index.html');
      const inp = p5.getByLabel('Un peru');
      await inp.evaluate((el) => { window.__inp = el; });
      await inp.click();
      await p5.keyboard.type('Shalom', { delay: 5 });
      const same = await p5.evaluate(() => document.querySelector('input[data-ap-input="name"]') === window.__inp && document.activeElement === window.__inp && window.__inp.value === 'Shalom');
      if (!same) throw new Error('input was re-created / lost focus while typing');
    } finally { srv2.close(); }
  });
  await step('no uncaught page errors', async () => {
    if (pageErrors.length) throw new Error(pageErrors.join('; '));
  });
} catch (e) {
  failed ||= 1;
  console.error(e.message);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `\nE2E FAILED` : `\nE2E passed`);
process.exit(failed ? 1 : 0);
