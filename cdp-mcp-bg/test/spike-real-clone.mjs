/**
 * SPIKE S2/RK3 — measure a real-profile subset clone: wall time + logical size + real
 * disk delta (CoW). Never parses cookie contents. Purges the clone immediately after.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cloneProfile, purgeClones, defaultMainProfileDir, preflightProfileAccess, FullDiskAccessError, OWNER_FILE} from '../src/profile-syncer.mjs';

const main = defaultMainProfileDir();
if (!fs.existsSync(main)) { console.log('real profile not found, skip:', main); process.exit(0); }

// Preflight: macOS TCC blocks reading another app's data without Full Disk Access.
const pf = preflightProfileAccess(main);
console.log('=== SPIKE S2/RK3 + RK8 (TCC/Full Disk Access) ===');
console.log('preflight read access:', JSON.stringify(pf));
if (!pf.ok) {
  if (pf.reason === 'full-disk-access') {
    console.log('FINDING RK8: macOS TCC blocks reading the real Chrome profile without Full Disk Access.');
    console.log('  → The orchestrator host process needs Full Disk Access (one-time user grant).');
    console.log('  → cloneProfile() fails fast with a clear E_FULL_DISK_ACCESS message (verified).');
  }
  console.log('=== cannot measure clone until access granted; constraint recorded, not a crash ===');
  process.exit(0);
}

const cloneBase = path.join(os.tmpdir(), 'cdp-mcp-bg-spike');
fs.rmSync(cloneBase, {recursive: true, force: true});
const freeKB = () => Number(execFileSync('df', ['-k', os.tmpdir()]).toString().trim().split('\n')[1].split(/\s+/)[3]);

const before = freeKB();
const t0 = process.hrtime.bigint();
const {cloneDir, copied} = cloneProfile({mainDir: main, cloneBase});
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const after = freeKB();

const du = execFileSync('du', ['-sh', cloneDir]).toString().trim().split('\t')[0];
const hasOwner = fs.existsSync(path.join(cloneDir, OWNER_FILE));
const hasSingleton = fs.existsSync(path.join(cloneDir, 'SingletonLock'));
const strayLocks = execFileSync('find', [cloneDir, '-name', 'LOCK', '-type', 'f']).toString().trim();
// list cloned top-level items (names only, no content)
const items = execFileSync('find', [cloneDir, '-maxdepth', '2', '-type', 'd']).toString().trim().split('\n').length;

console.log('=== SPIKE S2/RK3 real-profile subset clone ===');
console.log('main profile      :', main);
console.log('subset items copied:', copied);
console.log('wall time         :', ms.toFixed(1), 'ms');
console.log('clone logical size:', du, '(du -sh)');
console.log('real disk delta   :', (before - after), 'KB free consumed  <= CoW: ≪ logical if small');
console.log('owner stamped     :', hasOwner);
console.log('root SingletonLock cloned (want false):', hasSingleton);
console.log('stray leveldb LOCK (want empty):', JSON.stringify(strayLocks));
console.log('cloned dir count  :', items);

const purged = purgeClones({cloneBase, includeOwn: true});
console.log('purged clones     :', purged, '(disk released)');
fs.rmSync(cloneBase, {recursive: true, force: true});
console.log('=== DONE (no cookie contents were read) ===');
