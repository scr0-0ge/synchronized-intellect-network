// Interactive, report-only production walkthrough. Run after .\pnpm.bat build:
// .\pnpm.bat exec node tests/e2e/w24-use-it-like-a-person.mjs
// POST {code: "..."} to the printed loopback URL; bindings: app, page, snap,
// evidence, profile, root. POST {code: "await app.close(); server.close(); return 'closed'"}
// to finish. Never click Send, sign in, update/install, or scan real recovery data.
import { mkdir, mkdtemp, realpath, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join, dirname, parse } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

const root = resolve('.');
const evidence = join(root, '.scratch/unified-ai-workbench/evidence/w24-real-use');
await mkdir(evidence, { recursive: true });
const profileParent = await realpath(process.env.APPDATA);
const profile = process.env.W24_QA_PROFILE
  ? await realpath(process.env.W24_QA_PROFILE)
  : await mkdtemp(join(profileParent, 'uaw-w24-'));
if (dirname(profile) !== profileParent || !profile.startsWith(join(profileParent, 'uaw-w24-'))) {
  throw new Error('Only this lane\'s short uaw-w24-* profiles may be used');
}
const home = join(profile, 'home');
for (const dir of ['home', 'roaming', 'local', 'temp', 'projects', 'codex', 'claude']) {
  await mkdir(join(profile, dir), { recursive: true });
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  value !== undefined && !/^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)
  && !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN)/i.test(key)));
Object.assign(env, {
  PATH: `${dirname(process.execPath)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  HOME: home, USERPROFILE: home, HOMEDRIVE: parse(home).root.slice(0, 2),
  HOMEPATH: home.slice(2), APPDATA: join(profile, 'roaming'),
  LOCALAPPDATA: join(profile, 'local'), TEMP: join(profile, 'temp'),
  TMP: join(profile, 'temp'), TMPDIR: join(profile, 'temp'),
  CODEX_HOME: join(profile, 'codex'), CLAUDE_CONFIG_DIR: join(profile, 'claude'),
  // Stored fake keys may trigger a background catalog GET on a relaunch,
  // before Playwright can replace fetch. Keep that startup path loopback-only.
  GLM_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
});
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root, `--user-data-dir=${profile}`, '--window-placement=offscreen'],
  cwd: join(profile, 'projects'), env, timeout: 30000,
});
app.process().stdout?.on('data', data => appendFile(join(evidence, 'electron.log'), data));
app.process().stderr?.on('data', data => appendFile(join(evidence, 'electron.log'), data));
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
page.setDefaultTimeout(7000);
await app.evaluate(({ dialog }) => {
  globalThis.w24DialogQueue = [];
  globalThis.w24DialogCalls = [];
  globalThis.w24FetchCalls = [];
  globalThis.fetch = async (url, options) => {
    globalThis.w24FetchCalls.push({ url: String(url), method: options?.method ?? 'GET' });
    return new Response('{"error":{"message":"Invalid API key"}}', {status: 401, headers: {'Content-Type': 'application/json'}});
  };
  dialog.showSaveDialog = async (_window, options) => {
    globalThis.w24DialogCalls.push({ kind: 'save', options });
    const filePath = globalThis.w24DialogQueue.shift();
    return filePath ? { canceled: false, filePath } : { canceled: true };
  };
  dialog.showOpenDialog = async (_window, options) => {
    globalThis.w24DialogCalls.push({ kind: 'open', options });
    const filePath = globalThis.w24DialogQueue.shift();
    return { canceled: !filePath, filePaths: filePath ? [filePath] : [] };
  };
  dialog.showMessageBox = async () => { throw new Error('w24 refused native message box'); };
});
const safety = await app.evaluate(({ app, BrowserWindow, screen }) => ({
  userData: app.getPath('userData'), home: app.getPath('home'),
  versions: process.versions,
  windows: BrowserWindow.getAllWindows().map(w => ({ bounds: w.getBounds(), focusable: w.isFocusable(), focused: w.isFocused() })),
  displays: screen.getAllDisplays().map(d => d.bounds),
}));
if (safety.userData !== profile || safety.windows.some(w => w.focusable || w.focused ||
  safety.displays.some(d => w.bounds.x < d.x + d.width && w.bounds.x + w.bounds.width > d.x && w.bounds.y < d.y + d.height && w.bounds.y + w.bounds.height > d.y))) {
  await app.close();
  throw new Error('isolated offscreen precondition failed');
}
await writeFile(join(evidence, process.env.W24_QA_PROFILE ? 'launch-resumed.json' : 'launch.json'), JSON.stringify({profile, pid: app.process().pid, ...safety}, null, 2));
async function snap(name) {
  await page.screenshot({ path: join(evidence, `${name}.png`) });
  const facts = await page.evaluate(() => ({
    text: document.body.innerText, viewport: { width: innerWidth, height: innerHeight },
    root: document.documentElement.outerHTML.match(/^<html[^>]*>/)?.[0],
    overflow: { body: document.body.scrollWidth, document: document.documentElement.scrollWidth },
  }));
  facts.aria = await page.locator('body').ariaSnapshot();
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(facts, null, 2));
  return facts;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const server = createServer(async (req, res) => {
  let code = '';
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    code = JSON.parse(body).code;
    const result = await new AsyncFunction('app', 'page', 'snap', 'evidence', 'profile', 'root', 'server', code)(app, page, snap, evidence, profile, root, server);
    await appendFile(join(evidence, 'actions.jsonl'), JSON.stringify({at: new Date().toISOString(), code, result}) + '\n');
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({result: result ?? null}));
  } catch (error) {
    await appendFile(join(evidence, 'actions.jsonl'), JSON.stringify({at: new Date().toISOString(), code, error: String(error)}) + '\n');
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({error: String(error)}));
  }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({url: `http://127.0.0.1:${server.address().port}`, profile, pid: app.process().pid})));
setTimeout(async () => { await app.close().catch(() => {}); server.close(); }, 90 * 60 * 1000).unref();
