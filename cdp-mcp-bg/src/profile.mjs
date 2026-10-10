/**
 * The agent's OWN dedicated Chrome profile. This is NOT your real Chrome profile and NOT
 * a clone of it — you log into it ONCE (headful) and the agent reuses it headless. So:
 * no real-profile read, no Full Disk Access, no copying. Identity is never read by us
 * (we only check path existence, never parse cookies).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultProfileDir() {
  return path.join(os.homedir(), '.cdp-mcp-bg', 'agent-profile');
}

/** The user's REAL Chrome profile — which this tool must NEVER touch. */
export function realChromeProfileDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/** Enforce the bottom line in code: refuse to operate on (or around) the real Chrome profile. */
export function assertDedicated(dir = defaultProfileDir()) {
  const real = realChromeProfileDir();
  const r = path.resolve(dir);
  if (r === real || r.startsWith(real + path.sep) || real.startsWith(r + path.sep)) {
    throw new Error(`refusing to operate on your real Chrome profile (${dir}); cdp-mcp-bg uses only its own dedicated profile.`);
  }
}

/** Has the dedicated profile been initialized (logged into) at least once?
 *  Existence check only — never reads cookie contents. */
export function profileExists(dir = defaultProfileDir()) {
  try {
    return fs.existsSync(path.join(dir, 'Default')) || fs.existsSync(path.join(dir, 'Local State'));
  } catch {
    return false;
  }
}

/** Clear ALL identity in the agent profile (your call; agent-owned data only, no real Chrome). */
export function clearProfile(dir = defaultProfileDir()) {
  fs.rmSync(dir, {recursive: true, force: true});
  return dir;
}

// --- login coordination -----------------------------------------------------------------
// A visible one-time login and the headless agent can't both hold the profile at once
// (Chrome single-instance SingletonLock). These helpers let `login` claim the profile and
// the proxy release it, coordinated by one lock file. See design A1 / OrKoN #2621,#2745.

export function loginLockPath(dir = defaultProfileDir()) {
  return path.join(dir, '.cdp-login-active');
}

/** True while a visible login is in progress. Self-heals a stale lock (owner process dead). */
export function loginActive(dir = defaultProfileDir()) {
  let pid;
  try { pid = Number(fs.readFileSync(loginLockPath(dir), 'utf8').trim()); } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    if (e && e.code === 'EPERM') return true; // alive, not ours
    try { fs.rmSync(loginLockPath(dir), {force: true}); } catch { /* ignore */ } // stale → clear
    return false;
  }
}

export function setLoginActive(dir = defaultProfileDir()) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(loginLockPath(dir), String(process.pid));
}

export function clearLoginActive(dir = defaultProfileDir()) {
  fs.rmSync(loginLockPath(dir), {force: true});
}

/** Does a Chrome instance currently hold this profile (SingletonLock present)? */
export function profileInUse(dir = defaultProfileDir()) {
  return fs.existsSync(path.join(dir, 'SingletonLock'));
}

/** Is the SingletonLock held by a LIVE process? (distinguishes a live holder from a stale
 *  lock left by a SIGKILLed child). SingletonLock is a symlink "<host>-<pid>". Conservative:
 *  unknown/unparseable formats are treated as alive so we never strip a live lock. */
export function singletonOwnerAlive(dir = defaultProfileDir()) {
  const p = path.join(dir, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return false;      // no lock at all
    if (e && e.code === 'EINVAL') return fs.existsSync(p); // regular file, not a symlink
    return true;                                      // unreadable → assume alive (safe)
  }
  const m = /-(\d+)$/.exec(target);
  if (!m) return true;                                // unknown format → assume alive (safe)
  try { process.kill(Number(m[1]), 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** Remove a stale single-instance lock left by a killed headless child (so the visible
 *  login can claim the profile). Only call when we hold the login lock = exclusive intent. */
export function releaseSingleton(dir = defaultProfileDir()) {
  for (const n of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, n), {force: true}); } catch { /* ignore */ }
  }
}

