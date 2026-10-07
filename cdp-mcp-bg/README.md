# cdp-mcp-bg

后台无头 Chrome + 克隆 profile 复用登录态的 **MCP stdio 代理**，包在 `chrome-devtools-mcp` 外面。
**对 chrome-devtools-mcp 零改动**——只通过它既有的 CLI 驱动。设计见
`~/Documents/engineering-os/committers/chrome-devtools-mcp/design-headless-profile-clone.md`。

## 它做什么
- 把你真实 Chrome profile 的**一次性只读 CoW 副本**（APFS `cp -c`）喂给一个 **headless** chrome-devtools-mcp 子进程，复用登录态（含 session/SSO，靠 `--restore-last-session`）。
- 空闲自动关浏览器 + 删克隆（释放内存/磁盘），下次请求再克隆重启，**对 agent 透明**（连接不断、工具列表不变）。
- "用而不读 cookie"：`--no-javascript-evaluation` + `--no-category-network` + 关 telemetry + 不开 `--log-file`。
- 主 profile 只读不写（单一写入闸 `assertNotUnderMain`）；克隆用后即焚、带 owner 锁只删死主。

## 前置条件
- macOS + APFS。
- **零完全磁盘访问**：编排器只读你手动同步过来的**快照目录**，从不碰真实 Chrome profile，所以它和它启动的 Chrome 都**不需要任何磁盘权限**。
- 本地有 `chrome-devtools-mcp`（默认 `~/Code/stczwd/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`，可用 `CDP_MCP_BIN` 覆盖）。

## 手动同步（你来做，一次性/按需；编排器零权限）
登录态由**你**从真实 Chrome 同步到快照目录（默认 `~/.cdp-mcp-bg/profile-snapshot`）。编排器发现快照缺失/过期时，会向 agent 回一条 `E_NEEDS_SYNC` 提示让你来补。

```
npm run sync        # 真实 profile 的登录子集 → 快照目录（cp -c，CoW，极快）
```
- 若你这个终端没有读 Chrome 数据的权限，脚本会**明确提示**：用访达把 `Local State` 和 `Default` 拷到快照目录，或给你**自己的终端**开一次完全磁盘访问（只影响你的终端，**不是**编排器）。
- **清身份**：在真实 Chrome 清登录后重跑 `npm run sync`，或直接删快照目录——编排器的临时克隆空闲即焚，不留历史。
- 刚登录的 cookie 有 ~30s 落盘延迟（见设计 RK2），同步前稍等或优雅关一次 Chrome。

## 用
```
# 作为 MCP server 注册给 agent（stdio）：
node src/index.mjs
# 可调环境变量：
CDP_MCP_IDLE_MS=300000   # 空闲回收阈值（默认 5min）
CDP_MCP_BIN=/path/to/chrome-devtools-mcp.js
```

## 模块
| 文件 | 职责 |
|---|---|
| `src/profile-syncer.mjs` | CoW 克隆子集 + 剥锁 + owner 锁 + 单一写入闸 + preflight（M1） |
| `src/launch-args.mjs` | 身份安全的 chrome-devtools-mcp 启动参数 + 守卫 |
| `src/auth.mjs` | 不读 cookie 的登录墙检测（M3 核心） |
| `src/supervisor.mjs` | 子进程 swap（连接不断、请求排队）+ 空闲回收计时（M2） |
| `src/index.mjs` | stdio 代理：懒克隆 + 空闲回收 + initialize 重放（M4） |

## 测试
```
npm test          # 9 个单测：chokepoint/克隆/purge/args/登录检测/preflight/swap透明/idle
npm run spike:clone   # 真实 profile 克隆计时/磁盘（需完全磁盘访问；否则报 RK8 并退出）
```

## 现状 / 待办
- 已完成 + 单测绿：M1–M4 全模块。
- 待验（下步，不需插件）：S6 token 实测（公网页+临时 profile）、真实 profile 端到端（需你先授予完全磁盘访问）。
- 不覆盖：你的 proxy/灰度**插件**在 headless 下是否生效（S1/RK1，需用你的真实插件单独验）。
