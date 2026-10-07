#!/usr/bin/env node
/**
 * cdp-mcp-bg — MCP stdio proxy that runs chrome-devtools-mcp HEADLESS on the agent's own
 * DEDICATED profile (not your real Chrome, not a clone of it). You log into that profile
 * ONCE (`cdp-mcp-bg login`, headful); the agent reuses it headless. Bottom lines:
 *   - never read personal info: --no-javascript-evaluation + --no-category-network (use-not-read)
 *   - memory/cpu: headless + idle auto-close of the browser
 *   - disk: one profile (not per-task clones) + bounded Chrome cache
 * ZERO changes to chrome-devtools-mcp. No Full Disk Access, no copying your real profile.
 *
 * Usage:
 *   cdp-mcp-bg            run the MCP proxy on stdio (what the agent connects to)
 *   cdp-mcp-bg login [url]  open a VISIBLE Chrome on the dedicated profile to log in once
 *   cdp-mcp-bg clear       delete the dedicated profile (clear all agent-side identity)
 */
import process from 'node:process';
import readline from 'node:readline';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {defaultProfileDir, profileExists, clearProfile} from './profile.mjs';
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

function loginCmd() {
  fs.mkdirSync(PROFILE_DIR, {recursive: true});
  const url = process.argv[3] || 'https://www.google.com/';
  log('打开一个【可见】Chrome（专属 profile），在里面登录你要用的站点，然后关掉窗口即可。');
  log(`profile: ${PROFILE_DIR}`);
  const c = spawn(CHROME, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', url], {stdio: 'ignore', detached: true});
  c.unref();
  log('登完关窗口；之后 `cdp-mcp-bg` 会无头复用这个登录（session/SSO 靠 --restore-last-session 保活）。');
}

function clearCmd() {
  log('cleared agent profile:', clearProfile(PROFILE_DIR));
}
// placeholder-E

function argvFactory() {
  if (RAW_CHILD_ARGS) return [MCP_BIN, `--udd=${PROFILE_DIR}`];
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
    try { sup.stop(); } catch { /* ignore */ } // close browser → free memory/cpu (profile persists)
    log('idle: browser stopped (freed memory/cpu); profile kept');
  });
  const needLogin = id => writeUp({jsonrpc: '2.0', id, error: {code: -32002, message:
    `No agent profile yet. Run \`cdp-mcp-bg login\` once to log into ${PROFILE_DIR}, then retry.`}});

  readline.createInterface({input: process.stdin}).on('line', async line => {
    if (!line.trim()) return;
    idle.touch();
    let msg; try { msg = JSON.parse(line); } catch { return; }
    try {
      if (!profileExists(PROFILE_DIR)) { if (msg.id !== undefined) needLogin(msg.id); return; }
      if (msg.method === 'initialize') {
        sup.setInitializeParams(msg.params);
        await ensureStarted();
        if (msg.id !== undefined) writeUp({jsonrpc: '2.0', id: msg.id, result: sup.info});
        return;
      }
      await ensureStarted();
      if (msg.id === undefined) return; // notification upstream→server not forwarded
      writeUp({jsonrpc: '2.0', id: msg.id, result: await sup.request(msg.method, msg.params || {})});
    } catch (err) {
      if (msg && msg.id !== undefined) writeUp({jsonrpc: '2.0', id: msg.id, error: {code: -32001, message: err.message}});
      else log('error', err.message);
    }
  });
  const shutdown = () => { idle.stop(); try { sup.stop(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(`ready (profile ${PROFILE_DIR}, idle ${IDLE_MS}ms)`);
}

const sub = process.argv[2];
if (sub === 'login') loginCmd();
else if (sub === 'clear') clearCmd();
else proxyMain();
