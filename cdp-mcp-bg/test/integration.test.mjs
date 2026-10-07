import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INDEX = new URL('../src/index.mjs', import.meta.url).pathname;
const FAKE = new URL('./fake-mcp-child.mjs', import.meta.url).pathname;

function startProxy(env) {
  const proc = spawn('node', [INDEX], {stdio: ['pipe', 'pipe', 'inherit'],
    env: {...process.env, CDP_MCP_CMD: 'node', CDP_MCP_BIN: FAKE, CDP_RAW_CHILD_ARGS: '1', ...env}});
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
  return {proc, req};
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('integration: dedicated profile → serve MCP, idle-stop browser, transparent restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprof-'));
  fs.mkdirSync(path.join(profile, 'Default'), {recursive: true}); // profile "logged in once"
  const {proc, req} = startProxy({CDP_PROFILE_DIR: profile, CDP_MCP_IDLE_MS: '1000'});
  try {
    const init = await req('initialize', {});
    assert.equal(init.result.serverInfo.name, 'fake-mcp');
    assert.deepEqual((await req('tools/list')).result.tools.map(t => t.name), ['navigate_page', 'take_snapshot', 'screenshot']);
    const pid1 = (await req('ping')).result.pid;

    await sleep(1800); // > idle(1000) → browser stopped (memory/cpu freed), profile kept
    const pid2 = (await req('ping')).result.pid; // transparent restart on the SAME profile
    assert.notEqual(pid2, pid1, 'browser was restarted after idle');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(profile, {recursive: true, force: true});
  }
});

test('integration: no profile yet → prompt to run `cdp-mcp-bg login` (no real-profile read)', async () => {
  const missing = path.join(os.tmpdir(), 'agentprof-none-' + Date.now());
  const {proc, req} = startProxy({CDP_PROFILE_DIR: missing, CDP_MCP_IDLE_MS: '60000'});
  try {
    const r = await req('initialize', {});
    assert.ok(r.error, 'returns a prompt, not a crash');
    assert.match(r.error.message, /login/i, 'tells the user to log in once');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
});
