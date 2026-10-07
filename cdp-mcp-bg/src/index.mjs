#!/usr/bin/env node
/**
 * cdp-mcp-bg — MCP stdio proxy that runs chrome-devtools-mcp headless on an ephemeral
 * CoW clone of the real Chrome profile, reuses login (incl. session cookies via
 * --restore-last-session), tears the browser + clone down when idle, and re-clones on
 * the next request — transparent to the agent. ZERO changes to chrome-devtools-mcp.
 *
 * Prereqs: macOS + APFS. ZERO Full Disk Access: the clone source is a user-synced
 * profile snapshot (CDP_PROFILE_SNAPSHOT); when it is missing/stale the proxy returns a
 * NeedsSync prompt and the user re-logs-in + re-copies. Design doc:
 * committers/chrome-devtools-mcp/design-headless-profile-clone.md.
 *
 * Forwards JSON-RPC request/response (initialize, tools/list, tools/call, ...) AND
 * server→client notifications (logging/progress). Agent-side notifications (no id) are
 * dropped intentionally (chrome-devtools-mcp needs none post-initialize).
 */
import process from 'node:process';
import readline from 'node:readline';
import {cloneProfile, purgeClones, profileReady, NeedsSyncError, defaultStagingDir} from './profile-syncer.mjs';
import {buildMcpArgs, assertSafeArgs} from './launch-args.mjs';
import {ChildSupervisor, IdleTimer} from './supervisor.mjs';

const IDLE_MS = Number(process.env.CDP_MCP_IDLE_MS || 5 * 60 * 1000); // §4.2 default 5min
const MCP_CMD = process.env.CDP_MCP_CMD || 'node';
const MCP_BIN = process.env.CDP_MCP_BIN || `${process.env.HOME}/Code/stczwd/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`;
const STAGING_DIR = process.env.CDP_PROFILE_SNAPSHOT || defaultStagingDir(); // user-synced snapshot (zero FDA)
const CLONE_BASE = process.env.CDP_CLONE_BASE || undefined;
const RAW_CHILD_ARGS = process.env.CDP_RAW_CHILD_ARGS === '1'; // fake downstream for tests

const log = (...a) => process.stderr.write('[cdp-mcp-bg] ' + a.join(' ') + '\n'); // stderr only
const writeUp = obj => process.stdout.write(JSON.stringify(obj) + '\n');

let currentClone = null;

/** Clone from the user-synced staging snapshot on each (re)spawn; return the child argv. */
async function argvFactory() {
  const rdy = profileReady(STAGING_DIR);
  if (!rdy.ok) throw new NeedsSyncError(STAGING_DIR, rdy.reason); // prompt the user to sync
  const {cloneDir} = cloneProfile({mainDir: STAGING_DIR, cloneBase: CLONE_BASE});
  currentClone = cloneDir;
  if (RAW_CHILD_ARGS) return [MCP_BIN, `--clone=${cloneDir}`];
  const args = buildMcpArgs({cloneDir});
  assertSafeArgs(args);
  return [MCP_BIN, ...args];
}

const sup = new ChildSupervisor(MCP_CMD, argvFactory);
sup.onNotification = m => writeUp(m); // forward server→client notifications upstream (S-notif)
let starting = null;
async function ensureStarted() {
  if (sup.started()) return;
  if (!starting) starting = sup.start().finally(() => { starting = null; });
  await starting;
}
// placeholder-D

function teardown() {
  // idle: stop the browser (release memory) + purge the clone (release disk). §4.2/§4.7
  try { sup.stop(); } catch { /* ignore */ }
  try { purgeClones({cloneBase: CLONE_BASE, includeOwn: true}); } catch (e) { log('purge', e.message); }
  currentClone = null;
  log('idle teardown: browser stopped, clone purged');
}
const idle = new IdleTimer(IDLE_MS, teardown);

readline.createInterface({input: process.stdin}).on('line', async line => {
  if (!line.trim()) return;
  idle.touch();
  let msg; try { msg = JSON.parse(line); } catch { return; }
  try {
    if (msg.method === 'initialize') {
      sup.setInitializeParams(msg.params); // replayed to each (re)spawned child, internally
      await ensureStarted();
      if (msg.id !== undefined) writeUp({jsonrpc: '2.0', id: msg.id, result: sup.info});
      return;
    }
    await ensureStarted();
    if (msg.id === undefined) return; // notification; not forwarded (documented limitation)
    const result = await sup.request(msg.method, msg.params || {});
    writeUp({jsonrpc: '2.0', id: msg.id, result});
  } catch (err) {
    if (msg && msg.id !== undefined) writeUp({jsonrpc: '2.0', id: msg.id, error: {code: -32001, message: err.message}});
    else log('error', err.message);
  }
});

function shutdown() { idle.stop(); teardown(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { purgeClones({cloneBase: CLONE_BASE, includeOwn: true}); } catch { /* ignore */ } });
log('ready (idle', IDLE_MS + 'ms); waiting for agent on stdio');
