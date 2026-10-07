import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INDEX = new URL('../src/index.mjs', import.meta.url).pathname;
const FAKE = new URL('./fake-mcp-child.mjs', import.meta.url).pathname;

function fakeMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-main-'));
  fs.mkdirSync(path.join(dir, 'Default'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'Local State'), '{}');
  fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'X');
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  return dir;
}

test('integration: proxy lazy-clones, serves MCP, idle-purges, re-clones transparently', async () => {
  const mainDir = fakeMain();
  const cloneBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-clones-'));
  const proc = spawn('node', [INDEX], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {...process.env, CDP_PROFILE_SNAPSHOT: mainDir, CDP_CLONE_BASE: cloneBase,
      CDP_MCP_CMD: 'node', CDP_MCP_BIN: FAKE, CDP_RAW_CHILD_ARGS: '1', CDP_MCP_IDLE_MS: '1200'},
  });
  const waiters = new Map();
  readline.createInterface({input: proc.stdout}).on('line', l => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  let id = 0;
  const req = (method, params = {}) => new Promise(res => {
    const i = ++id; waiters.set(i, res);
    proc.stdin.write(JSON.stringify({jsonrpc: '2.0', id: i, method, params}) + '\n');
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const init = await req('initialize', {protocolVersion: '2025-06-18', capabilities: {}});
    assert.equal(init.result.serverInfo.name, 'fake-mcp');
    const tools = await req('tools/list');
    assert.deepEqual(tools.result.tools.map(t => t.name), ['navigate_page', 'take_snapshot', 'screenshot']);
    const p1 = await req('ping');
    const clone1 = p1.result.clone, pid1 = p1.result.pid;
    assert.ok(clone1.startsWith(cloneBase), 'child ran on a clone under CLONE_BASE');
    assert.ok(fs.existsSync(clone1), 'clone exists while active');

    await sleep(2000); // > idle(1200) → teardown fires
    assert.ok(!fs.existsSync(clone1), 'idle teardown purged the clone (disk released)');

    const p2 = await req('ping'); // triggers lazy re-clone + re-handshake, transparently
    assert.notEqual(p2.result.clone, clone1, 're-cloned to a fresh dir');
    assert.notEqual(p2.result.pid, pid1, 'a new child was spawned');
    assert.ok(fs.existsSync(p2.result.clone), 'new clone exists');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(mainDir, {recursive: true, force: true});
    fs.rmSync(cloneBase, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});

test('integration: missing staging snapshot → NeedsSync prompt to the agent (no FDA attempt)', async () => {
  const cloneBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-clones2-'));
  const missing = path.join(os.tmpdir(), 'ig-nope-' + Date.now());
  const proc = spawn('node', [INDEX], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {...process.env, CDP_PROFILE_SNAPSHOT: missing, CDP_CLONE_BASE: cloneBase,
      CDP_MCP_CMD: 'node', CDP_MCP_BIN: FAKE, CDP_RAW_CHILD_ARGS: '1', CDP_MCP_IDLE_MS: '60000'},
  });
  const waiters = new Map();
  readline.createInterface({input: proc.stdout}).on('line', l => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const req = (method, params = {}) => new Promise(res => {
    waiters.set(1, res);
    proc.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}) + '\n');
  });
  try {
    const r = await req('initialize', {});
    assert.ok(r.error, 'proxy returned an error (prompt), not a crash');
    assert.match(r.error.message, /profile snapshot/i, 'message tells the user to sync');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(cloneBase, {recursive: true, force: true});
  }
});
