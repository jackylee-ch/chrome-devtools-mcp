/**
 * AuthLifecycle detection — decide "is this page a login wall?" WITHOUT reading cookies.
 * Works on the rendered page signal only (url + accessibility snapshot text + http status).
 * See design §4.3. Heuristic; site-specific rules can augment (S4).
 */

// Common login-wall URL fragments (SSO/IdP + generic).
const LOGIN_URL_HINTS = [
  '/login', '/signin', '/sign-in', '/sso', '/oauth', '/auth/', '/account/login',
  'accounts.google.com', 'login.microsoftonline.com', 'okta.com', 'authn', 'idp',
];
// Phrases a logged-out page tends to render (en + zh).
const LOGIN_TEXT_HINTS = [
  'sign in', 'log in', 'login', 'sign-in', 'password', 'single sign-on', 'continue with',
  '登录', '登陆', '请登录', '账号登录', '统一身份认证', '身份验证', '口令', '密码',
];

export function isLoginWall({url = '', snapshotText = '', httpStatus = 0} = {}) {
  const reasons = [];
  const u = url.toLowerCase();
  if (LOGIN_URL_HINTS.some(h => u.includes(h))) reasons.push(`url~${u.slice(0, 80)}`);
  if (httpStatus === 401 || httpStatus === 403) reasons.push(`http ${httpStatus}`);
  const text = snapshotText.toLowerCase();
  const hits = LOGIN_TEXT_HINTS.filter(h => text.includes(h));
  // Require a password-ish signal OR 2+ generic hits to reduce false positives on pages
  // that merely link to a login.
  const strong = text.includes('password') || text.includes('密码') || text.includes('口令');
  if (strong || hits.length >= 2) reasons.push(`text:${hits.slice(0, 4).join(',')}`);
  return {login: reasons.length > 0 && (reasons.some(r => r.startsWith('http')) || strong || hits.length >= 2 || LOGIN_URL_HINTS.some(h => u.includes(h))), reasons};
}
