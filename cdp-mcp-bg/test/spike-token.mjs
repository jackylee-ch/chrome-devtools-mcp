/**
 * SPIKE S6 (approx, no FDA) — upper-bound token cost of a page snapshot. We measure the
 * RAW accessibility tree (Accessibility.getFullAXTree) on public pages with a throwaway
 * headless profile. chrome-devtools-mcp's take_snapshot truncates BELOW this (names≤100,
 * skips redundant), so raw-tree size is a safe upper bound. No login, no real profile.
 */
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-tok-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9781;
const proc = spawn(CHROME, [`--user-data-dir=${BASE}`, '--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', `--remote-debugging-port=${PORT}`, 'about:blank'],
  {stdio: 'ignore', detached: true});

async function pageWS() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const pg = list.find(t => t.type === 'page');
      if (pg) return pg.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('no page target');
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
    ws.addEventListener('open', () => resolve({send: (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({id: i, method, params})); })}));
    ws.addEventListener('error', reject);
  });
}
const estTokens = bytes => Math.round(bytes / 4);

try {
  const c = await connect(await pageWS());
  await c.send('Page.enable'); await c.send('Accessibility.enable');
  console.log('=== SPIKE S6 (raw a11y tree = upper bound on take_snapshot tokens) ===');
  for (const url of ['https://example.com/', 'https://news.ycombinator.com/']) {
    await c.send('Page.navigate', {url});
    await sleep(2500);
    const tree = await c.send('Accessibility.getFullAXTree', {});
    const nodes = (tree && tree.nodes) || [];
    const bytes = Buffer.byteLength(JSON.stringify(nodes));
    const names = nodes.map(n => (n.name && n.name.value) || '').filter(Boolean);
    const over100 = names.filter(s => s.length > 100).length;
    console.log(`${url}`);
    console.log(`  AX nodes: ${nodes.length}  raw JSON: ${(bytes / 1024).toFixed(1)} KiB  ~tokens(UB): ${estTokens(bytes)}  names>100ch(truncated by snapshot): ${over100}`);
  }
  console.log('注：raw AX 树是上界；chrome-devtools-mcp 的 take_snapshot 在此之下（名称≤100、去冗余，OrKoN #2895/#2896）。');
} finally {
  try { process.kill(-proc.pid); } catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
  await sleep(800); // let the killed Chrome release its profile files before rm
  fs.rmSync(BASE, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  console.log('=== DONE (throwaway profile purged; no login/real profile touched) ===');
}
