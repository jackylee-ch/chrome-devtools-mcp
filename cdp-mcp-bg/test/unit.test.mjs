import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {buildMcpArgs, assertSafeArgs} from '../src/launch-args.mjs';
import {isLoginWall} from '../src/auth.mjs';
import {profileExists, clearProfile, loginActive, setLoginActive, clearLoginActive, profileInUse, releaseSingleton, singletonOwnerAlive, assertDedicated, realChromeProfileDir} from '../src/profile.mjs';

test('buildMcpArgs: headless, identity-safe, bounded disk, no forbidden flags', () => {
  const args = buildMcpArgs({userDataDir: '/tmp/agent-profile'});
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--user-data-dir=/tmp/agent-profile'));
  assert.ok(args.includes('--no-javascript-evaluation'));
  assert.ok(args.includes('--no-category-network'));
  assert.ok(args.includes('--no-usage-statistics'));
  assert.ok(args.includes('--chrome-arg=--restore-last-session'));
  assert.ok(args.some(a => a.startsWith('--chrome-arg=--disk-cache-size=')), 'disk cache bounded');
  assert.ok(!args.some(a => a.startsWith('--log-file')));
  assert.doesNotThrow(() => assertSafeArgs(args));
  assert.throws(() => assertSafeArgs([...args, '--log-file=/tmp/l']), /forbidden/);
  assert.throws(() => buildMcpArgs({}), /userDataDir required/);
});

test('isLoginWall flags login pages, passes logged-in content (never reads cookies)', () => {
  assert.ok(isLoginWall({url: 'https://corp/sso/login', snapshotText: 'Please enter your password'}).login);
  assert.ok(isLoginWall({url: 'https://x', httpStatus: 401, snapshotText: ''}).login);
  assert.ok(isLoginWall({url: 'https://corp.int', snapshotText: '统一身份认证 请输入密码'}).login);
  assert.equal(isLoginWall({url: 'https://corp/dashboard', snapshotText: 'Welcome back, revenue 42'}).login, false);
});

test('profileExists: false until initialized, true once Default/Local State present; clearProfile wipes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprof-'));
  assert.equal(profileExists(dir), false, 'fresh dir has no login yet');
  fs.mkdirSync(path.join(dir, 'Default'), {recursive: true});
  assert.equal(profileExists(dir), true, 'Default present => initialized');
  clearProfile(dir);
  assert.equal(fs.existsSync(dir), false, 'clearProfile removed the agent profile');
});

test('login lock: set/active/clear, and self-heals a stale (dead-owner) lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprof-'));
  assert.equal(loginActive(dir), false);
  setLoginActive(dir);
  assert.equal(loginActive(dir), true, 'active while our pid owns it');
  clearLoginActive(dir);
  assert.equal(loginActive(dir), false);
  // stale lock from a dead process → treated inactive and auto-removed
  fs.writeFileSync(path.join(dir, '.cdp-login-active'), '2147480000');
  assert.equal(loginActive(dir), false, 'dead-owner lock is stale');
  assert.equal(fs.existsSync(path.join(dir, '.cdp-login-active')), false, 'stale lock cleared');
});

test('profileInUse / releaseSingleton reflect and clear the single-instance lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprof-'));
  assert.equal(profileInUse(dir), false);
  fs.writeFileSync(path.join(dir, 'SingletonLock'), 'host-123');
  assert.equal(profileInUse(dir), true);
  releaseSingleton(dir);
  assert.equal(profileInUse(dir), false, 'stale SingletonLock stripped');
});

test('singletonOwnerAlive: alive for live pid, false for dead/absent (so login never strips a live lock)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprof-'));
  assert.equal(singletonOwnerAlive(dir), false, 'no lock → not alive');
  fs.symlinkSync(`host-${process.pid}`, path.join(dir, 'SingletonLock'));
  assert.equal(singletonOwnerAlive(dir), true, 'live owner pid → alive');
  fs.rmSync(path.join(dir, 'SingletonLock'));
  fs.symlinkSync('host-2147480000', path.join(dir, 'SingletonLock'));
  assert.equal(singletonOwnerAlive(dir), false, 'dead owner pid → stale (safe to strip)');
});

test('assertDedicated: refuses the real Chrome profile (and its parents), allows the dedicated dir', () => {
  assert.throws(() => assertDedicated(realChromeProfileDir()), /real Chrome profile/);
  assert.throws(() => assertDedicated(path.join(realChromeProfileDir(), 'Default')), /real Chrome profile/);
  assert.throws(() => assertDedicated(path.dirname(realChromeProfileDir())), /real Chrome profile/); // parent
  assert.doesNotThrow(() => assertDedicated(path.join(os.homedir(), '.cdp-mcp-bg', 'agent-profile')));
});
