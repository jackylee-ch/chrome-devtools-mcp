#!/usr/bin/env node
/**
 * cdp-mcp-bg — MCP stdio proxy that runs chrome-devtools-mcp HEADLESS on the agent's own
 * DEDICATED profile (not your real Chrome, not a clone of it). You log into that profile
 * (`cdp-mcp-bg login [url]`, a one-time VISIBLE window); the agent reuses it headless.
 * Bottom lines:
 *   - never read personal info: --no-javascript-evaluation + --no-category-network
 *   - memory/cpu: headless + idle auto-close of the browser
 *   - disk: one profile (not per-task clones) + bounded Chrome cache
 * ZERO changes to chrome-devtools-mcp. No Full Disk Access, no copying your real profile.
 *
 * Usage:
 *   cdp-mcp-bg             run the MCP proxy on stdio (what the agent connects to)
 *   cdp-mcp-bg login [url] open a VISIBLE Chrome on the dedicated profile to log in
 *   cdp-mcp-bg clear       delete the dedicated profile (clear all agent-side identity)
 */
import process from 'node:process';
import readline from 'node:readline';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {defaultProfileDir, profileExists, clearProfile, loginActive, setLoginActive, clearLoginActive, singletonOwnerAlive, releaseSingleton, assertDedicated} from './profile.mjs';
import {buildMcpArgs, assertSafeArgs} from './launch-args.mjs';
import {ChildSupervisor, IdleTimer} from './supervisor.mjs';

const IDLE_MS = Number(process.env.CDP_MCP_IDLE_MS || 5 * 60 * 1000);
const MCP_CMD = process.env.CDP_MCP_CMD || 'node';
const MCP_BIN = process.env.CDP_MCP_BIN || `${process.env.HOME}/Code/stczwd/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`;
const PROFILE_DIR = process.env.CDP_PROFILE_DIR || defaultProfileDir();
const CHROME = process.env.CDP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RAW_CHILD_ARGS = process.env.CDP_RAW_CHILD_ARGS === '1'; // fake downstream for tests

const log = (...a) => process.stderr.write('[cdp-mcp-bg] ' + a.join(' ') + '\n'); // stderr only
const writeUp = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const errUp = (id, code, message) => writeUp({jsonrpc: '2.0', id, error: {code, message}});
const sleep = ms => new Promise(r => setTimeout(r, ms));
// placeholder-F

// One-time VISIBLE login. Claims the profile (login lock), waits for the headless browser
// to release the single-instance lock, opens Chrome, and waits until you close the window.
async function loginCmd() {
  const url = process.argv[3] || 'https://www.google.com/';
  setLoginActive(PROFILE_DIR);
  log(`等待后台无头浏览器释放 profile……（最多 8 秒）`);
  const deadline = Date.now() + 8000;
  while (singletonOwnerAlive(PROFILE_DIR) && Date.now() < deadline) await sleep(300);
  if (singletonOwnerAlive(PROFILE_DIR)) {
    // A LIVE instance still holds the profile — stripping its lock now would corrupt it
    // (two live Chromes). Bail; retry once the service is idle.
    clearLoginActive(PROFILE_DIR);
    log('✗ 后台浏览器仍占用 profile，未能在 8 秒内释放。确认 cdp-mcp-bg 空闲后重试 `cdp-mcp-bg login`。');
    process.exitCode = 2;
    return;
  }
  releaseSingleton(PROFILE_DIR); // only a STALE lock (SIGKILLed child) can remain now
  log(`打开可见 Chrome 登录：${url}`);
  log('登完请【关闭窗口】——关窗后 agent 才会继续（会用上你的新登录）。');
  try {
    const c = spawn(CHROME, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', url], {stdio: 'ignore'});
    await new Promise(res => { c.on('exit', res); c.on('error', res); });
  } finally {
    clearLoginActive(PROFILE_DIR);
  }
  log('登录窗口已关闭，profile 已更新。');
}

function clearCmd() {
  log('cleared agent profile:', clearProfile(PROFILE_DIR));
}

function argvFactory() {
  if (RAW_CHILD_ARGS) return [MCP_BIN, `--udd=${PROFILE_DIR}`];
  if (!fs.existsSync(MCP_BIN)) {
    throw new Error(`chrome-devtools-mcp build not found: ${MCP_BIN}. Build it (cd chrome-devtools-mcp && npm run build) or set CDP_MCP_BIN.`);
  }
  const a = buildMcpArgs({userDataDir: PROFILE_DIR});
  assertSafeArgs(a);
  return [MCP_BIN, ...a];
}

function proxyMain() {
  const sup = new ChildSupervisor(MCP_CMD, argvFactory);
  sup.onNotification = m => writeUp(m); // forward server→client notifications
  let starting = null;
  const ensureStarted = async () => {
    if (sup.started()) return;
    if (!starting) starting = sup.start().finally(() => { starting = null; });
    await starting;
  };
  const idle = new IdleTimer(IDLE_MS, () => {
    try { sup.stop(); } catch { /* ignore */ } // free memory/cpu (profile persists)
    log('idle: browser stopped (freed memory/cpu); profile kept');
  });
  // While a visible login is in progress, release the profile so the login can claim it.
  const guard = setInterval(() => {
    if (loginActive(PROFILE_DIR) && sup.started()) {
      log('login in progress → stopping headless browser to release the profile');
      try { sup.stop(); } catch { /* ignore */ }
    }
  }, 500);
  guard.unref?.();

  readline.createInterface({input: process.stdin}).on('line', async line => {
    if (!line.trim()) return;
    idle.touch();
    let msg; try { msg = JSON.parse(line); } catch { return; }
    try {
      if (loginActive(PROFILE_DIR)) {
        if (msg.id !== undefined) errUp(msg.id, -32003, `Login in progress on ${PROFILE_DIR}. Finish the browser login and CLOSE the window, then retry.`);
        return;
      }
      if (!profileExists(PROFILE_DIR)) {
        if (msg.id !== undefined) errUp(msg.id, -32002, `No agent profile yet. Run \`cdp-mcp-bg login\` once to log into ${PROFILE_DIR}, then retry.`);
        return;
      }
      if (msg.method === 'initialize') {
        sup.setInitializeParams(msg.params);
        await ensureStarted();
        if (msg.id !== undefined) writeUp({jsonrpc: '2.0', id: msg.id, result: sup.info});
        return;
      }
      await ensureStarted();
      if (msg.id === undefined) return; // upstream→server notification not forwarded
      writeUp({jsonrpc: '2.0', id: msg.id, result: await sup.request(msg.method, msg.params || {})});
    } catch (err) {
      if (msg && msg.id !== undefined) errUp(msg.id, -32001, err.message);
      else log('error', err.message);
    }
  });
  const shutdown = () => { idle.stop(); clearInterval(guard); try { sup.stop(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(`ready (profile ${PROFILE_DIR}, idle ${IDLE_MS}ms)`);
}

try { assertDedicated(PROFILE_DIR); } catch (e) { log(e.message); process.exit(2); } // never touch the real profile
const sub = process.argv[2];
if (sub === 'login') loginCmd();
else if (sub === 'clear') clearCmd();
else proxyMain();
