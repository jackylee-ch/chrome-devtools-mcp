/**
 * Builds the chrome-devtools-mcp argv for a background, read-only, identity-safe session.
 * Zero changes to chrome-devtools-mcp — we only drive its existing CLI flags.
 * See design §4.4 (use-not-read), §4.7 (no logs/telemetry), §5 (flags), RK6 (restore-session).
 */
export function buildMcpArgs({cloneDir, channel = 'stable', proxyServer, categoryExtensions = false} = {}) {
  if (!cloneDir) throw new Error('cloneDir required');
  const args = [
    '--headless',                       // true background, no window (R3)
    `--user-data-dir=${cloneDir}`,      // the ephemeral clone (3rd profile mode, §3.2)
    `--channel=${channel}`,
    '--isolated=false',                 // we manage the dir; must not conflict with --user-data-dir
    '--no-usage-statistics',            // identity not in telemetry (§4.7, L00B #2731)
    '--no-javascript-evaluation',       // block document.cookie read path (§4.4)
    '--no-category-network',            // drop get_network_request (Cookie/Set-Cookie headers)
    '--chrome-arg=--restore-last-session',   // keep session cookies alive in the clone (RK6/A7)
    '--chrome-arg=--hide-crash-restore-bubble',
  ];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (categoryExtensions) args.push('--category-extensions');
  // NOTE: deliberately NO --log-file (protocol traffic may carry cookies/credentials, §4.7).
  return args;
}

// Flags that must never appear (identity leakage / window / wrong profile mode).
export const FORBIDDEN_FLAGS = ['--log-file', '--make-default-browser'];

export function assertSafeArgs(args) {
  for (const bad of FORBIDDEN_FLAGS) {
    if (args.some(a => a === bad || a.startsWith(bad + '='))) {
      throw new Error(`forbidden flag present: ${bad}`);
    }
  }
  if (!args.includes('--headless')) throw new Error('must be headless (background only)');
  if (!args.includes('--no-javascript-evaluation')) throw new Error('must block JS eval (use-not-read)');
  return true;
}
