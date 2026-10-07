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
