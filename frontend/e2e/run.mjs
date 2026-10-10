// End-to-end test: real backend (serving the built Studio) + real Chromium. Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); throw e; }
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
