import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {assertNotUnderMain, cloneProfile, purgeClones, preflightProfileAccess, FullDiskAccessError, profileReady, NeedsSyncError, CLONE_SUBSET, OWNER_FILE} from '../src/profile-syncer.mjs';
import {buildMcpArgs, assertSafeArgs} from '../src/launch-args.mjs';
import {isLoginWall} from '../src/auth.mjs';

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

// Build a tiny fake "main profile" so we never touch the real one in unit tests.
function fakeMain() {
  const dir = tmp('fake-main-');
  fs.mkdirSync(path.join(dir, 'Default', 'Local Storage', 'leveldb'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'Local State'), '{}');
  fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'SQLITEFAKE');
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{"session":{}}');
  fs.writeFileSync(path.join(dir, 'Default', 'Local Storage', 'leveldb', 'LOCK'), '');
  fs.writeFileSync(path.join(dir, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'x');
  fs.writeFileSync(path.join(dir, 'SingletonLock'), 'host-123'); // must NOT be cloned (not in subset)
  return dir;
}

test('chokepoint rejects writes under main profile', () => {
  const main = fakeMain();
  assert.throws(() => assertNotUnderMain(path.join(main, 'Default', 'Cookies'), main), /chokepoint/);
  assert.throws(() => assertNotUnderMain(main, main), /chokepoint/);
  // a sibling temp path is allowed
  assert.doesNotThrow(() => assertNotUnderMain(path.join(os.tmpdir(), 'cdp-x', 'Cookies'), main));
});

test('cloneProfile copies subset, strips LOCK + singleton, stamps owner', () => {
  const main = fakeMain();
  const cloneBase = tmp('clones-');
  const {cloneDir, copied} = cloneProfile({mainDir: main, cloneBase});
  assert.ok(copied >= 3);
  assert.ok(fs.existsSync(path.join(cloneDir, 'Default', 'Cookies')));
  assert.equal(fs.readFileSync(path.join(cloneDir, 'Default', 'Cookies'), 'utf8'), 'SQLITEFAKE');
  // singleton at profile root is NOT in subset => never cloned
  assert.ok(!fs.existsSync(path.join(cloneDir, 'SingletonLock')));
  // stale leveldb LOCK stripped
  assert.ok(!fs.existsSync(path.join(cloneDir, 'Default', 'Local Storage', 'leveldb', 'LOCK')));
  // leveldb data still present
  assert.ok(fs.existsSync(path.join(cloneDir, 'Default', 'Local Storage', 'leveldb', '000003.log')));
  // owner stamped with our pid
  assert.equal(fs.readFileSync(path.join(cloneDir, OWNER_FILE), 'utf8'), String(process.pid));
});

test('purgeClones deletes dead-owner clones, keeps live-owner', () => {
  const main = fakeMain();
  const cloneBase = tmp('clones-');
  const {cloneDir: live} = cloneProfile({mainDir: main, cloneBase});
  // fabricate a dead-owner clone (pid 1 is alive but not ours => EPERM => treated alive;
  // use an unused high pid to simulate dead)
  const dead = fs.mkdtempSync(path.join(cloneBase, 'clone-'));
  fs.writeFileSync(path.join(dead, OWNER_FILE), '2147480000');
  const n = purgeClones({cloneBase});
  assert.equal(n, 1);
  assert.ok(fs.existsSync(live));      // live-owner kept
  assert.ok(!fs.existsSync(dead));     // dead-owner purged
});

test('buildMcpArgs is headless, identity-safe, no forbidden flags', () => {
  const args = buildMcpArgs({cloneDir: '/tmp/x'});
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--no-javascript-evaluation'));
  assert.ok(args.includes('--no-category-network'));
  assert.ok(args.includes('--no-usage-statistics'));
  assert.ok(args.includes('--chrome-arg=--restore-last-session'));
  assert.ok(!args.some(a => a.startsWith('--log-file')));
  assert.doesNotThrow(() => assertSafeArgs(args));
  assert.throws(() => assertSafeArgs([...args, '--log-file=/tmp/l']), /forbidden/);
});

test('isLoginWall flags login pages, passes logged-in content', () => {
  assert.ok(isLoginWall({url: 'https://corp/sso/login', snapshotText: 'Please enter your password'}).login);
  assert.ok(isLoginWall({url: 'https://x', httpStatus: 401, snapshotText: ''}).login);
  assert.ok(isLoginWall({url: 'https://corp.int', snapshotText: '统一身份认证 请输入密码'}).login);
  assert.equal(isLoginWall({url: 'https://corp/dashboard', snapshotText: 'Welcome back, revenue 42'}).login, false);
});

test('preflight ok on a readable profile; FullDiskAccessError carries code', () => {
  const main = fakeMain();
  assert.deepEqual(preflightProfileAccess(main), {ok: true});
  assert.equal(preflightProfileAccess(path.join(main, 'nope')).ok, false);
  assert.equal(new FullDiskAccessError('/x').code, 'E_FULL_DISK_ACCESS');
});

test('profileReady: ready on a synced snapshot, not-ready + reason when missing', () => {
  const staging = fakeMain(); // has Local State + Default
  assert.deepEqual(profileReady(staging), {ok: true});
  assert.equal(profileReady(path.join(staging, 'does-not-exist')).reason, 'missing-dir');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
  assert.equal(profileReady(empty).reason, 'missing-local-state');
  assert.equal(new NeedsSyncError(staging, 'missing-dir').code, 'E_NEEDS_SYNC');
});
