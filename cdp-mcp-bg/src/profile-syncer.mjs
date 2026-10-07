/**
 * ProfileSyncer — the ONLY module that touches real-profile paths.
 * Clones a SUBSET of the user's real Chrome profile with APFS copy-on-write (`cp -c`),
 * keeps cookie DB siblings for a recoverable snapshot, strips stale leveldb LOCKs, and
 * stamps an owner lockfile. Main profile is read-only; a single chokepoint asserts no
 * write ever resolves under it. See design-headless-profile-clone.md §4.1.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Clone only what carries login + extensions; exclude pure caches (disk control, RK3).
export const CLONE_SUBSET = [
  'Local State',
  'Default/Cookies', 'Default/Cookies-journal', 'Default/Cookies-wal', 'Default/Cookies-shm',
  'Default/Network',
  'Default/Local Storage', 'Default/Session Storage',
  'Default/Extensions', 'Default/Local Extension Settings',
  'Default/Extension State', 'Default/Extension Rules', 'Default/Extension Scripts',
  'Default/Preferences', 'Default/Secure Preferences',
];
export const OWNER_FILE = '.cdp-mcp-owner';

export function defaultMainProfileDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/** Single write chokepoint: throw if `targetPath` resolves under the main profile. */
export function assertNotUnderMain(targetPath, mainDir) {
  const main = fs.realpathSync(mainDir);
  let t = path.resolve(targetPath);
  while (!fs.existsSync(t) && path.dirname(t) !== t) t = path.dirname(t);
  const real = fs.realpathSync(t);
  if (real === main || real.startsWith(main + path.sep)) {
    throw new Error(`chokepoint: refusing to write under main profile (${targetPath})`);
  }
}

export class FullDiskAccessError extends Error {
  constructor(target) {
    super(
      `macOS blocked reading the real Chrome profile (TCC): ${target}\n` +
      `Grant Full Disk Access to the process that runs this orchestrator ` +
      `(System Settings → Privacy & Security → Full Disk Access), then retry.`,
    );
    this.code = 'E_FULL_DISK_ACCESS';
  }
}

function isEPERM(err) {
  const s = `${err && err.message}${err && err.stderr}`;
  return err && (err.code === 'EPERM' || /not permitted/i.test(s));
}

/**
 * Preflight: can we actually READ the real profile? On macOS this fails with EPERM
 * unless the host process has Full Disk Access. Returns {ok, reason}. Reads 1 byte of
 * a non-cookie config file only (never cookie contents).
 */
export function preflightProfileAccess(mainDir = defaultMainProfileDir()) {
  if (!fs.existsSync(mainDir)) return {ok: false, reason: 'profile-not-found'};
  const probe = path.join(mainDir, 'Local State');
  try {
    const fd = fs.openSync(probe, 'r');
    try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); }
    return {ok: true};
  } catch (err) {
    if (isEPERM(err)) return {ok: false, reason: 'full-disk-access'};
    return {ok: false, reason: `${err.code || 'read-error'}`};
  }
}

/**
 * Zero-FDA model: the clone SOURCE is a user-owned staging snapshot that the USER
 * populates (user-initiated copy has access; no tool ever reads the protected real
 * profile, so no Full Disk Access is granted to anything). The orchestrator only reads
 * this staging dir (user-owned → not TCC-protected) and prompts the user when it is
 * missing/empty.
 */
export function defaultStagingDir() {
  return path.join(os.homedir(), '.cdp-mcp-bg', 'profile-snapshot');
}

export class NeedsSyncError extends Error {
  constructor(stagingDir, why = 'missing') {
    super(
      `No usable profile snapshot (${why}) at: ${stagingDir}\n` +
      `In your real Chrome, make sure you are logged in, then copy your Chrome profile ` +
      `into that folder (see README「手动同步」), and retry. No Full Disk Access is required.`,
    );
    this.code = 'E_NEEDS_SYNC';
    this.stagingDir = stagingDir;
    this.why = why;
  }
}

/** Is the user-synced staging snapshot present and readable? (no FDA needed) */
export function profileReady(dir = defaultStagingDir()) {
  try {
    if (!fs.existsSync(dir)) return {ok: false, reason: 'missing-dir'};
    if (!fs.existsSync(path.join(dir, 'Local State'))) return {ok: false, reason: 'missing-local-state'};
    if (!fs.existsSync(path.join(dir, 'Default'))) return {ok: false, reason: 'missing-default'};
    const fd = fs.openSync(path.join(dir, 'Local State'), 'r');
    try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); }
    return {ok: true};
  } catch (err) {
    return {ok: false, reason: err && err.code === 'EPERM' ? 'unreadable-grant-not-on-staging' : (err && err.code) || 'error'};
  }
}

function cowCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), {recursive: true});
  // -c = APFS clonefile (CoW); falls back to full copy on non-APFS. -R recursive, -p preserve.
  try {
    execFileSync('cp', ['-cRp', src, dst], {stdio: ['ignore', 'ignore', 'pipe']});
  } catch (err) {
    if (isEPERM(err)) throw new FullDiskAccessError(src);
    throw err;
  }
}

// placeholder-A

/**
 * Clone the real profile subset into a fresh ephemeral dir. Returns {cloneDir}.
 * mainDir is only ever READ (cp source). The clone is owned by this process (pid stamp).
 */
export function cloneProfile({mainDir = defaultMainProfileDir(), cloneBase} = {}) {
  cloneBase = cloneBase || path.join(os.tmpdir(), 'cdp-mcp-bg-clones');
  if (!fs.existsSync(mainDir)) throw new Error(`main profile not found: ${mainDir}`);
  const pf = preflightProfileAccess(mainDir);
  if (!pf.ok && pf.reason === 'full-disk-access') throw new FullDiskAccessError(path.join(mainDir, 'Local State'));
  fs.mkdirSync(cloneBase, {recursive: true});
  const cloneDir = fs.mkdtempSync(path.join(cloneBase, 'clone-'));
  assertNotUnderMain(cloneDir, mainDir); // never clone into the main profile itself

  let copied = 0;
  for (const rel of CLONE_SUBSET) {
    const src = path.join(mainDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(cloneDir, rel);
    assertNotUnderMain(dst, mainDir);
    cowCopy(src, dst);
    copied++;
  }
  // Strip stale leveldb LOCKs inside the clone so the clone's Chrome re-locks its own copies.
  stripLocks(cloneDir, mainDir);
  // Stamp ownership (purge only deletes dead-owner clones).
  const owner = path.join(cloneDir, OWNER_FILE);
  assertNotUnderMain(owner, mainDir);
  fs.writeFileSync(owner, String(process.pid));
  return {cloneDir, copied};
}

function stripLocks(cloneDir, mainDir) {
  const out = execFileSync('find', [cloneDir, '-name', 'LOCK', '-type', 'f']).toString().trim();
  for (const f of out ? out.split('\n') : []) {
    assertNotUnderMain(f, mainDir);
    fs.rmSync(f, {force: true});
  }
}

function ownerAlive(cloneDir) {
  try {
    const pid = Number(fs.readFileSync(path.join(cloneDir, OWNER_FILE), 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // throws if dead
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // alive but not ours
  }
}

/** Purge clones whose owner process is dead. Never touches live-owner clones. Returns count. */
export function purgeClones({cloneBase, includeOwn = false} = {}) {
  cloneBase = cloneBase || path.join(os.tmpdir(), 'cdp-mcp-bg-clones');
  if (!fs.existsSync(cloneBase)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(cloneBase)) {
    const dir = path.join(cloneBase, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const ownPid = (() => {
      try { return Number(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim()); } catch { return 0; }
    })();
    const isOwn = ownPid === process.pid;
    if (ownerAlive(dir) && !(includeOwn && isOwn)) continue;
    fs.rmSync(dir, {recursive: true, force: true});
    n++;
  }
  return n;
}
