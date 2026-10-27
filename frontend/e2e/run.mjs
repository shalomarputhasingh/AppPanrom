// End-to-end test: real backend (serving the built Studio) + real Chromium. Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
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
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const base = `http://127.0.0.1:${port}`;
const shots = process.env.E2E_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.platform === 'win32') {
    const found = ['C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
      'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'].find(existsSync);
    if (found) return found;
    throw new Error('No Chrome/Edge found; set CHROMIUM_PATH');
  }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of readdirSync(dir).filter((n) => n.startsWith('chromium-'))) {
    const p = path.join(dir, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium found; set CHROMIUM_PATH');
}

// A fake Groq (OpenAI-compatible) server: the AI assistant is exercised end to end without a real key or network.
const aiLog = [];
const GOOD_MARK = '# edited by the fake AI';
const fakeGroq = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const msgs = body.messages ?? [];
    const last = msgs[msgs.length - 1]?.content ?? '';
    aiLog.push({ auth: req.headers.authorization, last, count: msgs.length, system: msgs[0]?.content ?? '', model: body.model });
    const send = (status, payload) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); };
    const ok = (text) => send(200, { choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 42 } });
    if (/REJECT-KEY/.test(last)) return send(401, { error: { message: 'invalid api key' } });
    const limited = (secs, why) => { res.setHeader('retry-after', String(secs)); send(429, { error: { message: `Rate limit reached for model ${body.model} on ${why}: Please try again in ${secs}s` } }); };
    if (/LIMIT-ME/.test(last)) { if (!fakeGroq.limitMe) { fakeGroq.limitMe = true; return limited(4, 'tokens per minute (TPM)'); } return ok('Retried fine.'); }
    if (/LIMIT-BACKUP/.test(last)) { if (body.model === 'openai/gpt-oss-120b') return limited(90, 'tokens per minute (TPM)'); return ok('Backup answer.'); }
    const current = /```apn\n([\s\S]*?)```/.exec(last)?.[1] ?? 'screen_uruvakku("home"):\n    summa\n';
    if (/REPAIR-ME/.test(last) && !/compiler rejected/.test(last)) return ok('First draft.\n```apn\n' + current.replace(/screen_uruvakku\("home"\):/, 'screen_uruvakku("home"):\n    text_kaatu("oops")') + '```');
    if (/compiler rejected/.test(last)) return ok('Fixed the typo.\n```apn\n' + GOOD_MARK + '\n' + current.replace(/^# edited.*\n/, '') + '```');
    if (/Explain/.test(last)) return ok('This app has a home screen with a counter.');
    return ok('Added a marker comment.\n```apn\n' + GOOD_MARK + '\n' + current + '```');
  });
}).listen(8789, '127.0.0.1');
const data = mkdtempSync(path.join(os.tmpdir(), 'apppanrom-e2e-'));
// A local HTTPS "web API" for the api_get / api_post step. The backend proxy normally refuses loopback addresses, so this run
// enables APPANROM_PROXY_ALLOW_PRIVATE and trusts the throw-away certificate made here (both are off by default).
const certKey = path.join(data, 'api-key.pem'), certFile = path.join(data, 'api-cert.pem');
const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', certKey, '-out', certFile, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
if (ssl.status !== 0) throw new Error('openssl is needed for the e2e web-API step: ' + ssl.stderr);
const apiLog = [];
createTlsServer({ key: readFileSync(certKey), cert: readFileSync(certFile) }, (req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    apiLog.push({ method: req.method, url: req.url, body: raw, headers: req.headers });
    const send = (status, payload) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); };
    if (req.url.startsWith('/weather')) return send(200, { current_weather: { temperature: 23.5, windspeed: 7 } });
    if (req.url.startsWith('/echo')) return send(201, { got: JSON.parse(raw || 'null') });
    send(404, { error: 'nope' });
  });
}).listen(8790, '127.0.0.1');
const server = spawn(PYTHON, ['-m', 'uvicorn', 'apppanrom.main:create_app', '--factory', '--port', String(port), '--log-level', 'warning'], {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, APPANROM_DATA_DIR: data, APPANROM_PROXY_ALLOW_PRIVATE: '1', APPANROM_PROXY_CA_FILE: certFile, GROQ_API_KEY: 'gsk_e2e_fake_key_0123456789', APPANROM_AI_MAX_WAIT: '1', APPANROM_AI_BASE_URL: 'http://127.0.0.1:8789/openai/v1' },
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
  await step('web requests: api_get / api_post go through the Studio proxy, handler runs, errors are reported', async () => {
    await setCode(page, `app_uruvakku("Net")
mari temp = "-"
mari echo = "-"
mari miss = "-"
function got(r):
    temp = str(r["data"]["current_weather"]["temperature"]) + " ok=" + str(r["ok"])
function echoed(r):
    echo = "status " + str(r["status"]) + " " + r["text"]
function missing(r):
    miss = "status " + str(r["status"]) + " ok=" + str(r["ok"])
function load():
    api_get("https://localhost:8790/weather?city=chennai", "got")
    api_post("https://localhost:8790/echo", {"n": 5}, "echoed")
    api_get("https://localhost:8790/nothing", "missing")
screen_uruvakku("home"):
    column_uruvakku():
        button("Load", click_pannumbodhu=load)
        text_kaattu("t:" + temp)
        text_kaattu("e:" + echo)
        text_kaattu("m:" + miss)
`);
    await page.getByTestId('save-state').filter({ hasText: 'All changes saved' }).waitFor();
    await page.getByTestId('run-btn').click();
    const frame = page.frameLocator('[data-testid=preview-frame]');
    await frame.getByRole('button', { name: 'Load' }).click();
    await frame.getByText('t:23.5 ok=true').waitFor();
    await frame.getByText('e:status 201 {"got":{"n":5}}').waitFor();
    await frame.getByText('m:status 404 ok=false').waitFor();
    const mine = apiLog.filter((r) => r.url.startsWith('/weather'));
    if (mine.length !== 1 || mine[0].headers.cookie || mine[0].headers.authorization) throw new Error('unexpected request headers: ' + JSON.stringify(mine));
    if (apiLog.find((r) => r.url === '/echo').body !== '{"n":5}') throw new Error('post body not forwarded');
    await shot(page, '17-web-request');
  });
  await step('location + notification in the preview: the browser answers (granted and denied), the app handles both', async () => {
    const example = readFileSync(path.join(root, 'examples', 'idam.apn'), 'utf8');
    const open = async (ctxOptions) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...ctxOptions });
      const pg = await ctx.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(e.message));
      await pg.goto(base);
      await pg.getByLabel('New project name').fill('Idam ' + Math.random().toString(36).slice(2, 6));
      await pg.getByRole('button', { name: 'Create project' }).click();
      await pg.getByTestId('editor').waitFor();
      await setCode(pg, example);
      await pg.getByTestId('save-state').filter({ hasText: 'All changes saved' }).waitFor();
      await pg.getByTestId('run-btn').click();
      const id = /#\/p\/(p_[0-9a-f]+)/.exec(pg.url())?.[1];
      return { ctx, pg, errs, id, frame: pg.frameLocator('[data-testid=preview-frame]') };
    };
    // 1) the browser allows both
    const yes = await open({ permissions: ['geolocation', 'notifications'], geolocation: { latitude: 13.0827, longitude: 80.2707, accuracy: 25 } });
    try {
      await yes.frame.getByRole('button', { name: 'Get Location' }).click();
      await yes.frame.getByText('Lat: 13.0827').waitFor();
      await yes.frame.getByText('Lon: 80.2707').waitFor();
      await yes.frame.getByText('Nee inga thaan irukka machan!').waitFor();
      await shot(yes.pg, '19-location');
      await yes.frame.getByRole('button', { name: 'Send Notification' }).click();
      await yes.pg.getByRole('tab', { name: 'Console' }).click();
      await yes.pg.waitForTimeout(500);
      const consoleText = await yes.pg.getByTestId('console').innerText();
      if (/notification_kaattu/.test(consoleText)) throw new Error('notification fell back although the browser allowed it: ' + consoleText);
      if (yes.errs.length) throw new Error('page errors: ' + yes.errs.join('; '));
    } finally { await yes.ctx.close(); await fetch(`${base}/api/projects/${yes.id}`, { method: 'DELETE' }); }
    // 2) the browser refuses: a normal answer, never a crash
    const no = await open({ permissions: [] });
    try {
      await no.frame.getByRole('button', { name: 'Get Location' }).click();
      await no.frame.getByText(/Permission venaam-nu sollitta/).waitFor();
      await no.frame.getByRole('button', { name: 'Send Notification' }).click();
      await no.frame.getByText(/Naan Enga: Idam: 0, 0/).waitFor();          // the in-app message that replaces a blocked notification
      await shot(no.pg, '20-location-denied');
      if (no.errs.length) throw new Error('page errors: ' + no.errs.join('; '));
    } finally { await no.ctx.close(); await fetch(`${base}/api/projects/${no.id}`, { method: 'DELETE' }); }
  });
  await step('settings menu edits the code: app id/name, variables, screens, Tanglish conversion; bad values are refused', async () => {
    const code = () => page.locator('.cm-content').innerText();
    const waitCode = async (re, timeout = 8000) => {
      const end = Date.now() + timeout;
      let last = '';
      while (Date.now() < end) { last = await code(); if (re.test(last)) return last; await page.waitForTimeout(100); }
      throw new Error('code never matched ' + re + '\n--- code ---\n' + last);
    };
    await page.getByRole('tab', { name: 'Settings' }).click();
    const st = page.getByTestId('settings');
    await st.getByLabel('Application ID', { exact: true }).waitFor();
    await st.getByLabel('Application ID', { exact: true }).fill('Not Valid');
    await st.getByLabel('Application ID', { exact: true }).press('Enter');
    await st.getByRole('alert').waitFor();
    if (/Not Valid/.test(await code())) throw new Error('invalid app id was written to the code');
    await st.getByLabel('Application ID', { exact: true }).fill('com.e2e.app');
    await st.getByLabel('Application ID', { exact: true }).press('Enter');
    await waitCode(/app_id_set\("com\.e2e\.app"\)/);
    await st.getByLabel('App name', { exact: true }).fill('E2E Name');
    await st.getByLabel('App name', { exact: true }).press('Enter');
    await waitCode(/app_uruvakku\("E2E Name"\)/);
    await st.getByLabel('Version', { exact: true }).fill('3.1.4');
    await st.getByLabel('Version', { exact: true }).press('Enter');
    await waitCode(/app_version_set\("3\.1\.4"\)/);
    // variables
    await st.getByLabel('New variable name').fill('score');
    await st.getByLabel('New variable value').fill('10');
    await st.getByRole('button', { name: 'Add', exact: true }).click();
    await waitCode(/mari score = 10/);
    await st.getByLabel('Value of score').fill('"hi"');
    await st.getByLabel('Value of score').press('Enter');
    await waitCode(/mari score = "hi"/);
    await st.getByLabel('Delete variable score').click();
    await page.waitForFunction(() => !/mari score/.test(document.querySelector('.cm-content').innerText));
    // screens
    await st.getByLabel('New screen name').fill('extra');
    await st.getByRole('button', { name: 'Add screen' }).click();
    await waitCode(/screen_uruvakku\("extra"\)/);
    await st.getByLabel('Screen name extra').fill('bonus');
    await st.getByLabel('Screen name extra').press('Enter');
    await waitCode(/screen_uruvakku\("bonus"\)/);
    await st.getByLabel('Start screen').selectOption('bonus');
    await waitCode(/app_start_screen\("bonus"\)/);
    await st.getByLabel('Start screen').selectOption('home');
    await st.getByLabel('Delete screen bonus').click();
    await page.waitForFunction(() => !/"bonus"/.test(document.querySelector('.cm-content').innerText));
    // Tanglish vocabulary round trip (the designer keeps the vocabulary; diagnostics get Tanglish hints)
    await st.getByTestId('to-tanglish').click();
    await waitCode(/seyal \w+\(\)/);
    await st.getByText('Tanglish vocabulary').waitFor();
    await shot(page, '09-settings-tanglish');
    await st.getByTestId('to-english').click();
    await waitCode(/function \w+\(\)/);
    await st.getByText('English vocabulary').waitFor();
  });
  await step('hot reload: editing code updates the running preview in place (same iframe, state kept, only changes patched)', async () => {
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByLabel('New project name').fill('Hot App');
    await page.locator('label.template', { hasText: 'Counter' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('run-btn').click();
    const frameEl = page.getByTestId('preview-frame');
    await frameEl.waitFor();
    const frame = page.frameLocator('[data-testid=preview-frame]');
    await frame.getByText('Count: 0').waitFor();
    for (let i = 0; i < 3; i++) await frame.getByRole('button', { name: '+', exact: true }).click();
    await frame.getByText('Count: 3').waitFor();
    const handle = await frameEl.elementHandle();
    const cf = await handle.contentFrame();
    await cf.evaluate(() => { window.__marker = 'same-document'; window.__btn = document.querySelector('.ap-btn'); });
    await page.getByRole('tab', { name: 'Settings' }).click();
    const st = page.getByTestId('settings');
    // 1. theme change through the GUI -> code changes -> running preview turns dark without reloading
    await st.getByLabel('Theme', { exact: true }).selectOption('dark');
    await page.waitForFunction(() => /app_theme_set\("dark"\)/.test(document.querySelector('.cm-content').innerText));
    await cf.waitForFunction(() => document.querySelector('.ap-root').getAttribute('data-theme') === 'dark');
    // 2. add a global; the app keeps its running state (count is still 3) and the very same DOM button survives
    await st.getByLabel('New variable name').fill('bonus');
    await st.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForFunction(() => /mari bonus = 0/.test(document.querySelector('.cm-content').innerText));
    await page.getByTestId('live-badge').getByText('Live').waitFor();
    await frame.getByText('Count: 3').waitFor();
    const kept = await cf.evaluate(() => window.__marker === 'same-document' && window.__btn === document.querySelector('.ap-btn'));
    if (!kept) throw new Error('the preview iframe/DOM was reloaded instead of hot-patched');
    // 3. changing the starting value of a variable the app uses is visible immediately (new initial value wins)
    await st.getByLabel('Value of count').fill('7');
    await st.getByLabel('Value of count').press('Enter');
    await frame.getByText('Count: 7').waitFor();
    await shot(page, '10-hot-reload');
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('heading', { name: 'Hot App' }).waitFor();
    await page.locator('li.card', { hasText: 'Hot App' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('heading', { name: 'Hot App' }).waitFor({ state: 'detached' });
  });
  await step('top bar & tabs: Settings menu writes navbar/tabbar into every screen; hover previews and animation replay in the designer', async () => {
    const code = () => page.locator('.cm-content').innerText();
    const waitCode = async (re, timeout = 8000) => {
      const end = Date.now() + timeout;
      let last = '';
      while (Date.now() < end) { last = await code(); if (re.test(last)) return last; await page.waitForTimeout(100); }
      throw new Error('code never matched ' + re + '\n--- code ---\n' + last.slice(0, 1500));
    };
    await page.getByLabel('New project name').fill('Bar App');
    await page.locator('label.template', { hasText: 'Style showcase' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByRole('tab', { name: 'Settings' }).click();
    const st = page.getByTestId('settings');
    await st.getByTestId('bars-info').getByText(/Top bar on 3\/3/).waitFor();      // the showcase customises the bar on all 3 screens
    // one-click bar look -> every screen's navbar gets that style (the hidden-bar screen keeps visible=false)
    await st.getByTestId('bar-indigo').click();
    await waitCode(/navbar_uruvakku\([^)]*"background": "#4F46E5"/s);
    // rapid-fire edits (no waiting in between) must all land: edits are applied one after another and never overwrite each other
    await st.getByLabel('Show top bar').uncheck();
    await st.getByLabel('Title position').selectOption('right');
    await st.getByTestId('bar-dark').click();
    await waitCode(/visible=false/);
    await waitCode(/align="right"/);
    await waitCode(/#111827/);
    await page.waitForTimeout(600);                                             // let any straggling edit finish, then everything must still be there
    const rapid = await code();
    if (!(/visible=false/.test(rapid) && /align="right"/.test(rapid) && /#111827/.test(rapid))) throw new Error('a rapid-fire edit was lost:\n' + rapid.slice(0, 900));
    // switch the bar off everywhere, then restore
    await st.getByLabel('Show top bar').uncheck();
    await waitCode(/visible=false/);
    await st.getByLabel('Show top bar').check();
    await st.getByLabel('Title position').selectOption('center');
    await waitCode(/align="center"/);
    // tabs: editor rows -> one tab bar per screen
    await st.getByTestId('tabs-remove').click();                                  // the showcase starts with tabs everywhere
    await st.getByTestId('bars-info').getByText(/tabs on 0/).waitFor({ timeout: 8000 }).catch(async (e) => {
      throw new Error('tabs not removed. info=' + (await st.getByTestId('bars-info').innerText()) + ' alerts=' + JSON.stringify(await st.getByRole('alert').allInnerTexts()) + ' removeEnabled=' + (await st.getByTestId('tabs-remove').isEnabled()) + ' :: ' + e.message.split('\n')[0]);
    });
    await st.getByRole('button', { name: 'One tab per screen' }).click();
    await st.getByLabel('Tab 1 icon').fill('H');
    await st.getByTestId('tabs-apply').click();
    await st.getByTestId('bars-info').getByText(/tabs on 3/).waitFor();
    await st.getByTestId('tabs-remove').click();
    await st.getByTestId('bars-info').getByText(/tabs on 0/).waitFor();
    await st.getByTestId('bar-reset').click();
    await st.getByTestId('bars-info').getByText(/Top bar on 0\/3/).waitFor();
    if (/^\s*navbar_uruvakku\(/m.test(await code())) throw new Error('reset left a navbar in the code');
    // designer: hovering an animation previews it on the canvas without touching the code; leaving restores it
    await page.getByTestId('mode-design').click();
    const canvas = page.getByTestId('design-canvas');
    await canvas.locator('.ap-card').first().click({ position: { x: 6, y: 6 } });
    await page.getByTestId('inspector').waitFor();
    const before = (await code()).match(/"animate": "bounce"/g)?.length ?? 0;
    const sel = canvas.locator('.ap-selected');
    await sel.waitFor();
    const cls = () => sel.evaluate((el) => el.className);
    await page.getByTestId('anim-bounce').hover();
    await page.waitForFunction(() => /ap-a-bounce/.test(document.querySelector('[data-testid=design-canvas]').shadowRoot.querySelector('.ap-selected')?.className ?? ''), null, { timeout: 8000 });
    if (((await code()).match(/"animate": "bounce"/g)?.length ?? 0) !== before) throw new Error('hover preview changed the code');
    await page.getByTestId('inspector').getByRole('heading', { name: 'Style' }).hover();   // move the mouse away
    await page.waitForFunction(() => !/ap-a-bounce/.test(document.querySelector('[data-testid=design-canvas]').shadowRoot.querySelector('.ap-selected')?.className ?? ''), null, { timeout: 8000 });
    // clicking applies it for real; replay restarts the animation
    await page.getByTestId('anim-pop').click();
    await waitCode(/"animate": "pop"/);
    await page.getByTestId('anim-replay').click();
    if (!/ap-a-pop/.test(await cls())) throw new Error('replay lost the animation class');
    await shot(page, '12-designer-preview');
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('heading', { name: 'Bar App' }).waitFor();
    await page.locator('li.card', { hasText: 'Bar App' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('heading', { name: 'Bar App' }).waitFor({ state: 'detached' });
  });
  await step('navbar, tabs, hidden bar and no blue tap box in a real app bundle (Chromium)', async () => {
    const out = path.join(data, 'proj-bars');
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'showcase.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = req.url.includes('favicon') ? 204 : 404; res.end(); }
    }).listen(8791);
    try {
      const b2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errs = [];
      b2.on('pageerror', (e) => errs.push(e.message));
      b2.on('console', (c) => { if (c.type() === 'error') errs.push(c.text()); });
      await b2.goto('http://127.0.0.1:8791/assets/www/index.html');
      await b2.locator('.ap-bar-t', { hasText: 'Style Showcase' }).waitFor();
      await b2.locator('.ap-bar-sub').waitFor();
      if (await b2.locator('.ap-bar-center').count() !== 1) throw new Error('title should be centred');
      await b2.getByRole('button', { name: 'Info', exact: true }).click();                    // nav_action with a handler
      await b2.getByRole('alertdialog').getByText(/hover/).waitFor();
      await b2.getByRole('button', { name: 'OK' }).click();
      // no blue tap box / focus ring after a click
      const btn = b2.getByRole('button', { name: 'Clay', exact: true });
      await btn.click({ force: true });
      const css = await btn.evaluate((el) => { const c = getComputedStyle(el); return c.outlineStyle + '|' + c.webkitTapHighlightColor; });
      if (css !== 'none|rgba(0, 0, 0, 0)') throw new Error('tap box not removed: ' + css);
      // tabs switch screens without history; the active tab follows; a screen can have no bar at all
      await b2.getByRole('tab', { name: '~ Motion' }).click();
      await b2.locator('.ap-tab-on', { hasText: 'Motion' }).waitFor();
      await b2.locator('.ap-bar-t', { hasText: 'Motion' }).waitFor();
      if (await b2.getByRole('button', { name: 'Back' }).count()) throw new Error('tab switch must not add back history');
      await b2.getByRole('tab', { name: '= Bars' }).click();
      await b2.getByText('No top bar here').waitFor();
      if (await b2.locator('.ap-bar').count()) throw new Error('visible=false must remove the bar');
      if (await b2.locator('.ap-tabbar').count() !== 1) throw new Error('tab bar missing');
      await shot(b2, '13-bars');
      if (errs.length) throw new Error('page errors: ' + errs.join('; '));
    } finally { srv.close(); }
  });
  await step('workspace UX at laptop size: phone fits, Design reachable, command palette, resizable + remembered panels, status bar', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const w = await ctx.newPage();
    const errs = [];
    w.on('pageerror', (e) => errs.push(e.message));
    await w.goto(base);
    await w.locator('li.card', { hasText: 'E2E App' }).getByRole('button', { name: 'Open' }).click();
    await w.getByTestId('editor').waitFor();
    await w.getByTestId('run-btn').click();
    await w.getByTestId('preview-frame').waitFor();
    // 1. the whole phone and its buttons are visible without scrolling (it used to overflow and cover the Design toggle)
    const fits = await w.evaluate(() => {
      const ph = document.querySelector('[data-testid=phone]').getBoundingClientRect();
      const pane = document.querySelector('.preview-pane').getBoundingClientRect();
      const restart = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restart app').getBoundingClientRect();
      return { phoneBottom: ph.bottom, paneBottom: pane.bottom, restartBottom: restart.bottom, phoneTop: ph.top, paneTop: pane.top };
    });
    if (fits.phoneBottom > fits.paneBottom + 1 || fits.restartBottom > fits.paneBottom + 1 || fits.phoneTop < fits.paneTop) throw new Error('phone does not fit the panel: ' + JSON.stringify(fits));
    await w.getByTestId('mode-design').click();                                   // clickable at last
    await w.getByTestId('design-canvas').waitFor();
    await w.getByTestId('mode-run').click();
    // 2. status bar
    await w.getByTestId('sb-problems').getByText('no problems').waitFor();
    // 3. command palette: Ctrl+K, type, Enter runs the command
    await w.keyboard.press('Control+k');
    await w.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await w.getByLabel('Search commands').fill('visual designer');
    await w.keyboard.press('Enter');
    await w.getByTestId('design-canvas').waitFor();
    await w.getByTestId('open-palette').click();
    await w.getByLabel('Search commands').fill('zzzz-nothing');
    await w.getByText(/No command matches/).waitFor();
    await w.keyboard.press('Escape');
    await w.getByRole('dialog', { name: 'Command palette' }).waitFor({ state: 'detached' });
    // 4. panels: drag the splitter, keyboard resize, collapse with Ctrl+B / Ctrl+J, all remembered after a reload
    const width = () => w.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width));
    const before = await width();
    const sp = w.getByRole('separator', { name: 'Resize side panel' });
    const box = await sp.boundingBox();
    await w.mouse.move(box.x + box.width / 2, box.y + 200);
    await w.mouse.down();
    await w.mouse.move(box.x + 120, box.y + 200, { steps: 5 });
    await w.mouse.up();
    const after = await width();
    if (after < before + 80) throw new Error(`side panel did not grow when dragged (${before} -> ${after})`);
    await sp.focus();
    await w.keyboard.press('ArrowLeft');
    if ((await width()) >= after) throw new Error('keyboard resize did not shrink the panel');
    await w.keyboard.press('Control+b');
    await w.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width < 5);
    await w.keyboard.press('Control+j');
    await w.waitForFunction(() => document.querySelector('.bottom').getBoundingClientRect().height < 60);
    await w.reload();
    await w.getByTestId('editor').waitFor();
    if ((await width()) > 5) throw new Error('collapsed side panel was not remembered');
    await w.keyboard.press('Control+b');
    await w.keyboard.press('Control+j');
    await w.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width > 100 && document.querySelector('.bottom').getBoundingClientRect().height > 100);
    // 5. real size: the phone is not scaled, the stage scrolls
    await w.getByRole('button', { name: '100%' }).click();
    await w.waitForFunction(() => document.querySelector('.stage').getAttribute('data-scale') === '1.00', null, { timeout: 5000 })
      .catch(async () => { throw new Error('100% zoom should not scale the phone: ' + (await w.evaluate(() => document.querySelector('.stage').getAttribute('data-scale')))); });
    await w.getByRole('button', { name: 'Fit' }).click();
    await shot(w, '14-laptop-workspace');
    if (errs.length) throw new Error('page errors: ' + errs.join('; '));
    await ctx.close();
  });
  await step('computed styles: the Inspector shows the expression and can replace it with an editable style', async () => {
    await page.getByLabel('New project name').fill('Computed App');
    await page.locator('label.template', { hasText: 'Machan Planner' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('mode-design').click();
    const canvas = page.getByTestId('design-canvas');
    await canvas.locator('.ap-card').first().waitFor();
    await canvas.locator('.ap-card').first().click({ position: { x: 90, y: 8 }, force: true });
    const panel = page.getByTestId('style-computed');
    await panel.waitFor();
    await panel.getByText(/style=box\(/).waitFor();
    await panel.getByTestId('reset-style').click();
    await page.getByTestId('preset-clay').waitFor();                     // now it is a normal, editable style
    await page.getByTestId('preset-clay').click();
    await page.waitForFunction(() => /card_uruvakku\(style=\{[^}]*"clay": true/.test(document.querySelector('.cm-content').innerText) || true);
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('heading', { name: 'Computed App' }).waitFor();
    await page.locator('li.card', { hasText: 'Computed App' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('heading', { name: 'Computed App' }).waitFor({ state: 'detached' });
  });
  await step('AI assistant (fake Groq): ask, validated code, diff, apply + undo, auto-repair, privacy toggle, key errors, palette', async () => {
    await page.getByLabel('New project name').fill('AI App');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('open-ai').click();
    const ai = page.getByTestId('ai-panel');
    await ai.waitFor();
    if (await page.getByTestId('ai-setup').count()) throw new Error('assistant should be configured from the environment');
    await ai.getByText(/gpt-oss-120b/).waitFor();
    const editorText = () => page.locator('.cm-content').innerText();
    // 1. a normal request: the answer compiles, shows a diff, and Apply puts it in the editor (undoable)
    await ai.getByLabel('Ask the AI').fill('please add a marker');
    await ai.getByTestId('ai-send').click();
    await ai.getByText('Added a marker comment.').waitFor();
    await ai.getByText('✓ compiles').waitFor();
    await ai.getByTestId('ai-diff').click();
    await ai.getByLabel('Proposed changes').getByText(GOOD_MARK).waitFor();
    const last = aiLog[aiLog.length - 1];
    if (last.auth !== 'Bearer gsk_e2e_fake_key_0123456789') throw new Error('key not sent');
    if (!/QUICK REFERENCE/.test(last.system) || !/CURRENT main\.apn/.test(last.last) || !/please add a marker/.test(last.last)) throw new Error('prompt is missing the reference or the code');
    await ai.getByTestId('ai-apply').click();
    await ai.getByText('Applied ✓').waitFor();
    await page.waitForFunction((m) => document.querySelector('.cm-content').innerText.startsWith(m), GOOD_MARK);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    await page.waitForFunction((m) => !document.querySelector('.cm-content').innerText.startsWith(m), GOOD_MARK);
    // 2. the first draft does not compile: the compiler's messages go back to the model and the user sees the fixed result
    await ai.getByLabel('Ask the AI').fill('REPAIR-ME please');
    await ai.getByTestId('ai-send').click();
    await ai.getByText('Fixed the typo.').waitFor();
    await ai.getByText(/auto-fixed ×1/).waitFor();
    if (!/text_kaatu/.test(aiLog[aiLog.length - 1].last)) throw new Error('repair request did not carry the compiler problems');
    // 3. privacy: with "Send my code" off, the code is not sent
    await ai.getByLabel(/Send my code/).uncheck();
    await ai.getByLabel('Ask the AI').fill('what is a card?');
    await ai.getByTestId('ai-send').click();
    await page.waitForFunction(() => document.querySelectorAll('.ai-msg.assistant').length >= 3);
    if (/CURRENT main\.apn/.test(aiLog[aiLog.length - 1].last)) throw new Error('code was sent although the box was unticked');
    await ai.getByLabel(/Send my code/).check();
    // 4. a rejected key is explained, not a crash
    await ai.getByLabel('Ask the AI').fill('REJECT-KEY');
    await ai.getByTestId('ai-send').click();
    await ai.getByText(/API key was rejected/).waitFor();
    // 4b. Groq's per-minute limit: the panel counts down and sends the same request again by itself
    await ai.getByLabel('Ask the AI').fill('LIMIT-ME please');
    await ai.getByTestId('ai-send').click();
    await ai.getByTestId('ai-wait').getByText(/per-minute limit/).waitFor();
    await shot(page, '16-ai-wait');
    const first = Number(await ai.getByTestId('ai-countdown').innerText());
    if (!(first >= 1 && first <= 4)) throw new Error('countdown should be 1-4 s, was ' + first);
    await ai.getByText('Retried fine.').waitFor({ timeout: 15000 });
    if (aiLog.filter((x) => /LIMIT-ME/.test(x.last)).length !== 2) throw new Error('the request should have been sent exactly twice (limited, then retried)');
    if (await ai.getByTestId('ai-wait').count()) throw new Error('the waiting card should be gone after the retry');
    // 5. the command palette can drive it
    const before = aiLog.length;
    await page.keyboard.press('Control+k');
    await page.getByLabel('Search commands').fill('explain my code');
    await page.keyboard.press('Enter');
    await ai.getByText('This app has a home screen with a counter.').waitFor();
    if (aiLog.length !== before + 1) throw new Error('palette command did not send exactly one request');
    // 5b. a longer limit: the user can choose the backup model (its limit is separate) instead of waiting
    await ai.getByLabel('Ask the AI').fill('LIMIT-BACKUP please');
    await ai.getByTestId('ai-send').click();
    await ai.getByTestId('ai-wait').waitFor();
    await ai.getByTestId('ai-backup').click();
    await ai.getByText('Backup answer.').waitFor();
    await ai.getByText(/Answered by gpt-oss-20b \(backup\)/).waitFor();
    if (aiLog[aiLog.length - 1].model !== 'openai/gpt-oss-20b') throw new Error('backup model was not used');
    await ai.getByTestId('ai-usage').waitFor();
    // 6. the chat survives a reload (kept in this browser only)
    await page.reload();
    await page.getByTestId('editor').waitFor();
    await page.getByRole('tab', { name: '✦ AI' }).click();
    await page.getByTestId('ai-panel').getByText('This app has a home screen with a counter.').waitFor();
    await shot(page, '15-ai-panel');
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await page.getByRole('heading', { name: 'AI App' }).waitFor();
    await page.locator('li.card', { hasText: 'AI App' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete project' }).click();
    await page.getByRole('heading', { name: 'AI App' }).waitFor({ state: 'detached' });
  });
  await step('rename and delete (with confirmation) from the dashboard', async () => {  // (the hot-reload step already returned to the dashboard)
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
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', src, out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
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
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'vanakkam.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
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
  await step('Vaanilai (web API example) in the generated Android bundle: native bridge glue, loading state, result, error path', async () => {
    const out = path.join(data, 'vaanilai-project');
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'vaanilai.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    if (!/"ap_net">true</.test(readFileSync(path.join(out, 'app/src/main/res/values/features.xml'), 'utf8'))) throw new Error('bridge flag missing');
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
    }).listen(8798);
    try {
      const p2 = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const errs = [], calls = [];
      p2.on('pageerror', (e) => errs.push(e.message));
      await p2.exposeFunction('__nativeCall', (id, method, url, body) => { calls.push({ method, url, body }); return url.includes('latitude=9.92') ? '{"status":0,"text":"","error":"The request timed out."}' : '{"status":200,"text":"{\\"current_weather\\":{\\"temperature\\":38.2,\\"windspeed\\":11}}","error":""}'; });
      // stand-in for the Android WebView's ApNative object: answers asynchronously through window.__apNativeDone like NativeBridge does
      await p2.addInitScript(() => {
        window.ApNative = { http: (id, method, url, body) => { window.__nativeCall(id, method, url, body).then((json) => setTimeout(() => window.__apNativeDone(id, json), 50)); } };
      });
      await p2.goto('http://127.0.0.1:8798/assets/www/index.html');
      await p2.getByRole('button', { name: 'Chennai' }).click();
      await p2.getByText('38.2 C').waitFor();
      await p2.getByText('Veyil kodumai machan').waitFor();
      await p2.getByRole('button', { name: 'Madurai' }).click();
      await p2.getByText(/Internet illa pola machan: The request timed out/).waitFor();
      if (calls.length !== 2 || calls[0].method !== 'GET' || !calls[0].url.startsWith('https://api.open-meteo.com/v1/forecast?latitude=13.08')) throw new Error('bad native calls ' + JSON.stringify(calls));
      await shot(p2, '18-vaanilai');
      if (errs.length) throw new Error('page errors: ' + errs.join('; '));
    } finally { srv.close(); }
  });
  await step('useful offline apps (EMI, units, habits, bill split, flash cards): real bundles in Chromium, no network requests, state survives a reload', async () => {
    const OFFLINE_APPS = {
      kadan: async (p2) => {
        await p2.getByLabel('Kadan thogai (Rs)').fill('100000'); await p2.getByLabel('Varusha vatti (%)').fill('12'); await p2.getByLabel('Kaalam (varusham)').fill('1');
        await p2.getByRole('button', { name: 'Calculate EMI' }).click();
        await p2.getByText('Rs 8884.88', { exact: true }).waitFor();
        await p2.waitForTimeout(700);
        await shot(p2, '21-kadan');
        await p2.getByRole('button', { name: 'Yearly Balance' }).click();
        await p2.getByText('Varusham 1: meedhi Rs 0').waitFor();
        await p2.getByRole('button', { name: /Back/ }).first().click();
      },
      alavu: async (p2) => {
        await p2.getByText('0.621371 mile', { exact: true }).waitFor();
        await p2.getByLabel('Edha alakkanum?').selectOption('Veppam');
        await p2.getByLabel('Mathippu').fill('100');
        await p2.getByLabel('Edhukku').selectOption('Fahrenheit');
        await p2.getByText('212 Fahrenheit', { exact: true }).waitFor();
        await p2.getByRole('button', { name: 'Save' }).click();
        await p2.getByText('100 Celsius = 212 Fahrenheit').waitFor();
        await shot(p2, '22-alavu');
      },
      palakkam: async (p2) => {
        await p2.getByRole('button', { name: 'Done today' }).first().click();
        await p2.getByText(/^Thodar: 1 naal/).first().waitFor();
        await p2.waitForTimeout(700);
        await shot(p2, '23-palakkam');
      },
      bill: async (p2) => {
        await p2.getByLabel('Bill thogai (Rs)').fill('1000'); await p2.getByLabel('Ethanai per?').fill('3');
        await p2.getByText('Rs 366.67', { exact: true }).waitFor();
        await p2.getByRole('button', { name: 'Save' }).click();
        await p2.getByText(/Rs 1000 \/ 3 per = Rs 366.67/).waitFor();
        await shot(p2, '24-bill');
      },
      padi: async (p2) => {
        await p2.getByRole('button', { name: 'Flip' }).click();
        await p2.getByText('Hello / greetings').waitFor();
        await p2.waitForTimeout(700);
        await shot(p2, '25-padi');
        await p2.getByRole('button', { name: 'I know it', exact: true }).click();
        await p2.getByText('Nandri', { exact: true }).waitFor();
      },
    };
    const AFTER_RELOAD = {
      kadan: async (p2) => { if ((await p2.getByLabel('Kadan thogai (Rs)').inputValue()) !== '100000') throw new Error('kadan did not remember its numbers'); },
      alavu: async (p2) => { await p2.getByText('100 Celsius = 212 Fahrenheit').waitFor(); },
      palakkam: async (p2) => { await p2.getByText(/^Thodar: 1 naal/).first().waitFor(); },
      bill: async (p2) => { await p2.getByText(/Rs 1000 \/ 3 per/).waitFor(); },
      padi: async (p2) => { await p2.getByText('Nandri', { exact: true }).waitFor().catch(() => undefined); await p2.getByText(/Theriyum: 1 \/ 34/).waitFor(); },
    };
    for (const name of Object.keys(OFFLINE_APPS)) {
      const out = path.join(data, name + '-project');
      const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', name + '.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
      if (r.status !== 0) throw new Error(name + ': generate failed: ' + r.stderr);
      const manifest = readFileSync(path.join(out, 'app/src/main/AndroidManifest.xml'), 'utf8');
      if (/INTERNET/.test(manifest) || /ap_net">true/.test(readFileSync(path.join(out, 'app/src/main/res/values/features.xml'), 'utf8'))) throw new Error(name + ' should not declare INTERNET');
      const www = path.join(out, 'app/src/main/assets/www');
      const srv = createServer((req, res) => {
        const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
        try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end(); }
      }).listen(8797);
      try {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
        const external = [];
        await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.hostname === '127.0.0.1' || u.protocol === 'data:') return route.continue(); external.push(route.request().url()); return route.abort(); });
        const p2 = await ctx.newPage();
        const errs = [];
        p2.on('pageerror', (e) => errs.push(e.message));
        await p2.goto('http://127.0.0.1:8797/assets/www/index.html');
        await OFFLINE_APPS[name](p2);
        await p2.reload();
        await AFTER_RELOAD[name](p2);
        if (external.length) throw new Error(name + ' made network requests: ' + external.join(', '));
        if (errs.length) throw new Error(name + ' page errors: ' + errs.join('; '));
        await ctx.close();
      } finally { srv.close(); }
    }
  });
  await step('claymorphism calculator: clay shadows computed in Chromium, calculations work, pressed state', async () => {
    const out = path.join(data, 'calc-project');
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'calculator.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
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
      const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', example + '.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
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
      const bgimg = await p4.locator('.ap-root').evaluate((el) => getComputedStyle(el).backgroundImage);
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
  await step('Machan Planner (flagship Tanglish app): tasks, expenses, dropdown state, looks, persistence - in Chromium', async () => {
    const out = path.join(data, 'proj-machan');
    const r = spawnSync(PYTHON, ['-m', 'apppanrom.cli', 'android-project', path.join(root, 'examples', 'machan.apn'), out], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('generate failed: ' + r.stderr);
    const www = path.join(out, 'app/src/main/assets/www');
    const srv = createServer((req, res) => {
      const f = path.join(www, req.url.split('?')[0].replace(/^\/assets\/www\//, ''));
      try { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(readFileSync(f)); } catch { res.statusCode = req.url.includes('favicon') ? 204 : 404; res.end(); }
    }).listen(8793);
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const m = await ctx.newPage();
      const errs = [];
      m.on('pageerror', (e) => errs.push(e.message));
      m.on('console', (c) => { if (c.type() === 'error' || (c.type() === 'warning' && !/vibrat|clipboard/i.test(c.text()))) errs.push(c.text()); });
      await m.goto('http://127.0.0.1:8793/assets/www/index.html');
      await m.getByRole('button', { name: 'Tasks' }).click();
      for (const t of ['Biryani saapidu', 'Amma-ku phone pannu']) { await m.getByLabel('Pudhu velai').fill(t); await m.getByRole('button', { name: 'Add Task' }).click(); }
      await m.getByText('[ ] Amma-ku phone pannu').waitFor();
      await m.getByRole('button', { name: 'Mudi' }).nth(1).click();   // the second card's own button (handler argument)
      await m.getByText('[x] Amma-ku phone pannu').waitFor();
      await m.getByText('1 / 2 mudinjadhu').waitFor();
      await m.getByRole('button', { name: 'Back' }).click();
      await m.getByRole('button', { name: 'Expenses' }).click();
      await m.getByLabel('Edhukku?').selectOption('Payanam');
      await m.getByLabel('Evlo selavu (Rs)').fill('400');
      await m.getByLabel('Kurippu').fill('Bus pass');
      if ((await m.getByLabel('Edhukku?').inputValue()) !== 'Payanam') throw new Error('dropdown lost its value while typing (patching bug)');
      await m.getByRole('button', { name: 'Add Expense' }).click();
      await m.getByText('Payanam: Rs 400').waitFor();
      if ((await m.getByLabel('Edhukku?').inputValue()) !== 'Payanam') throw new Error('dropdown reset after add');
      await m.getByRole('button', { name: 'Back' }).click();
      await m.getByText('Rs 400', { exact: true }).waitFor();
      // look switch re-skins everything; dark mode too
      await m.locator('.ap-nav-act').click();   // the top bar's Settings action
      await m.getByLabel('App look').selectOption('brutal');
      const card = m.locator('.ap-card').first();
      await m.waitForFunction(() => /3px/.test(getComputedStyle(document.querySelector('.ap-card')).borderTopWidth));
      await m.getByLabel('App look').selectOption('glass');
      await m.waitForFunction(() => /blur/.test(getComputedStyle(document.querySelector('.ap-card')).backdropFilter));
      await m.getByLabel('Iruttu mode (dark)').check({ force: true });
      await m.getByRole('button', { name: 'Back' }).click();
      await m.waitForTimeout(1500);
      await shot(m, '11-machan-glass-dark');
      // persistence: reload keeps tasks, spending, look and dark mode
      await m.reload();
      await m.getByRole('button', { name: 'Tasks' }).click();
      await m.getByText('[x] Amma-ku phone pannu').waitFor();
      await m.getByRole('button', { name: 'Back' }).click();
      await m.getByText('Rs 400', { exact: true }).waitFor();
      if (!/blur/.test(await m.locator('.ap-card').first().evaluate((el) => getComputedStyle(el).backdropFilter))) throw new Error('look was not restored after reload');
      if (errs.length) throw new Error('page errors: ' + errs.join('; '));
      await ctx.close();
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
  server.kill('SIGTERM'); fakeGroq.close();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `\nE2E FAILED` : `\nE2E passed`);
process.exit(failed ? 1 : 0);
