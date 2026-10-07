#!/usr/bin/env node
/**
 * 手动同步 — YOU run this (in your own Terminal/Finder context), NOT the orchestrator.
 * Copies the login-bearing subset of your REAL Chrome profile into the staging snapshot
 * that the orchestrator reads. The orchestrator itself never touches the real profile and
 * never needs Full Disk Access; this one-time/occasional copy is user-initiated.
 *
 *   node scripts/sync.mjs            # real → ~/.cdp-mcp-bg/profile-snapshot
 *   CDP_PROFILE_SNAPSHOT=/x node scripts/sync.mjs
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CLONE_SUBSET, defaultStagingDir, defaultMainProfileDir} from '../src/profile-syncer.mjs';

const src = process.env.CDP_REAL_PROFILE || defaultMainProfileDir();
const dst = process.env.CDP_PROFILE_SNAPSHOT || defaultStagingDir();
if (!fs.existsSync(src)) { console.error('real Chrome profile not found:', src); process.exit(1); }

console.log(`同步 ${src}\n   → ${dst}`);
fs.rmSync(dst, {recursive: true, force: true});
fs.mkdirSync(dst, {recursive: true});

let copied = 0;
for (const rel of CLONE_SUBSET) {
  const s = path.join(src, rel);
  if (!fs.existsSync(s)) continue;
  const d = path.join(dst, rel);
  fs.mkdirSync(path.dirname(d), {recursive: true});
  try {
    execFileSync('cp', ['-cRp', s, d], {stdio: ['ignore', 'ignore', 'pipe']});
    copied++;
  } catch (err) {
    const msg = `${err && err.message}${err && err.stderr}`;
    if (/not permitted/i.test(msg) || (err && err.code === 'EPERM')) {
      console.error('\n✗ 这个终端没有读取 Chrome 数据的权限（macOS TCC）。');
      console.error('  编排器本身不需要任何权限——需要权限的只是你这一步「拷贝」。两条路，任选其一：');
      console.error('  1) 用访达(Finder)把 ~/资源库/Application Support/Google/Chrome 里的');
      console.error('     「Local State」和「Default」文件夹拷到：' + dst);
      console.error('  2) 或给你常用的这个终端开一次完全磁盘访问（只影响你的终端，不影响编排器）。');
      process.exit(2);
    }
    throw err;
  }
}
console.log(`✓ 同步完成，拷贝 ${copied} 项。现在编排器可用这份快照（无需任何磁盘权限）。`);
console.log('  要清身份：在真实 Chrome 清登录后重跑本脚本（或删掉上面的快照目录）即可。');
