/**
 * Builds the chrome-devtools-mcp argv for a background, read-only, identity-safe session
 * on the agent's DEDICATED profile. Zero changes to chrome-devtools-mcp — we only drive
 * its existing CLI flags. Bottom lines enforced here: never read personal info
 * (use-not-read), bounded disk (cache cap).
 */
const DEFAULT_DISK_CACHE_BYTES = 256 * 1024 * 1024; // bound Chrome's on-disk cache (disk control)

export function buildMcpArgs({userDataDir, channel = 'stable', proxyServer, categoryExtensions = false, diskCacheBytes = DEFAULT_DISK_CACHE_BYTES} = {}) {
  if (!userDataDir) throw new Error('userDataDir required');
  const args = [
    '--headless',                       // true background, no window (R3)
    `--user-data-dir=${userDataDir}`,   // the agent's dedicated profile (not your real Chrome)
    `--channel=${channel}`,
    '--isolated=false',                 // we manage the dir; must not conflict with --user-data-dir
    '--no-usage-statistics',            // identity not in telemetry
    '--no-javascript-evaluation',       // block document.cookie read path (use-not-read)
    '--no-category-network',            // drop get_network_request (Cookie/Set-Cookie headers)
    '--chrome-arg=--restore-last-session',           // keep session/SSO logins alive headless
    '--chrome-arg=--hide-crash-restore-bubble',
    `--chrome-arg=--disk-cache-size=${diskCacheBytes}`, // bounded disk cache (disk control)
  ];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (categoryExtensions) args.push('--category-extensions');
  // NOTE: deliberately NO --log-file (protocol traffic may carry cookies/credentials).
  return args;
}

export const FORBIDDEN_FLAGS = ['--log-file', '--make-default-browser'];

export function assertSafeArgs(args) {
  for (const bad of FORBIDDEN_FLAGS) {
    if (args.some(a => a === bad || a.startsWith(bad + '='))) {
      throw new Error(`forbidden flag present: ${bad}`);
    }
  }
  if (!args.includes('--headless')) throw new Error('must be headless (background only)');
  if (!args.includes('--no-javascript-evaluation')) throw new Error('must block JS eval (use-not-read)');
  if (!args.includes('--no-category-network')) throw new Error('must drop network tools (use-not-read)');
  return true;
}
