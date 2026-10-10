# cdp-mcp-bg

后台无头 MCP 代理，包在 `chrome-devtools-mcp` 外面，跑在 **agent 自己的专属 Chrome profile** 上。
**对 chrome-devtools-mcp 零改动**。登录只做一次（可见窗口），之后无头复用——**不碰你的真实
Chrome、不需要完全磁盘访问、不拷贝你的 profile**。

## 底线（硬约束）
- **不读个人信息**：`--no-javascript-evaluation`（堵 `document.cookie`）+ `--no-category-network`（去掉回传 Cookie 头的工具）+ 关 telemetry + 不开 `--log-file`。模型只看到渲染后的页面，看不到 cookie 值。
- **内存/CPU 可控**：headless + 空闲 N 分钟自动关浏览器（释放内存/CPU），下次请求再拉起。
- **磁盘可控**：只有一个专属 profile（不是每任务克隆）+ Chrome 缓存上限（`--disk-cache-size`）；要清就 `cdp-mcp-bg clear`。

## 用法
```
# 1) 登录（弹出可见 Chrome，登你要用的站点，然后【关窗口】）：
cdp-mcp-bg login                       # 默认打开 google
cdp-mcp-bg login https://要登的站点/    # 直接开在那一页

# 2) 作为 MCP 服务跑（agent 连它的 stdio）：
cdp-mcp-bg                             # = node src/index.mjs
#   可调：CDP_MCP_IDLE_MS（空闲回收，默认 5min）、CDP_PROFILE_DIR、CDP_MCP_BIN

# 3) 清掉所有 agent 侧身份：
cdp-mcp-bg clear                       # 删除专属 profile（只动 agent 自己的数据）
```
**按需登录（推荐姿势）**：日常无需预登录——agent 撞到登录墙时，由它运行 `cdp-mcp-bg login <那一页>`，你在弹出的可见窗口里登录、**关窗**，agent 自动继续。
协调细节：`login` 会先让后台无头浏览器**释放 profile**（二者不能同时占用，Chrome 单实例锁），登录期间代理对工具调用回 `login in progress` 提示；你关窗后代理透明重启、带上新登录。没登录就跑会回 `cdp-mcp-bg login` 提示，绝不碰你的真实 profile。session/SSO 靠 `--restore-last-session` 无头保活。
> 注意：`login` 和 `cdp-mcp-bg` 服务要用**同一个 profile 目录**（默认都是 `~/.cdp-mcp-bg/agent-profile`；若自定义 `CDP_PROFILE_DIR` 两边都要设）。同一 profile 同时只有一个浏览器实例。

## 模块
| 文件 | 职责 |
|---|---|
| `src/profile.mjs` | 专属 profile 目录 + 存在性检查（不读内容）+ clear |
| `src/launch-args.mjs` | 身份安全 + 磁盘上限的 chrome-devtools-mcp 启动参数 + 守卫 |
| `src/auth.mjs` | 不读 cookie 的登录墙检测（判断是否该重新登录） |
| `src/supervisor.mjs` | 子进程生命周期（透明重启 + 空闲回收计时 + 通知转发） |
| `src/index.mjs` | stdio 代理 + `login`/`clear` 子命令 |

## 测试
```
npm test            # 单测 + 代理 + 端到端集成（专属 profile 服务 / 空闲重启 / 未登录提示）
npm run spike:token # 快照 token 上界实测（token/资源观测，公网页 + 临时 profile）
```
