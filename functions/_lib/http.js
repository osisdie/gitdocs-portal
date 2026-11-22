// Response helpers shared by the middleware and the API.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
  });
}

export const errorJson = (status, message) => json({ error: message }, status);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Error pages are bilingual (English first — the portal's default language — then 繁體中文). JSON errors keep the
// message as given: clients show their own translated text.
const PAGE_TEXT = {
  '尚未開通，請聯絡管理員': { en: 'Your account is not enabled yet. Please contact the administrator.', zh: '尚未開通，請聯絡管理員' },
  '沒有權限檢視這份文件': { en: 'You do not have permission to view this document.', zh: '沒有權限檢視這份文件' },
  '機密文件需要 editor 權限': { en: 'This document is confidential: it needs the editor role in its project.', zh: '機密文件需要 editor 權限' },
  'server mode misconfigured': { en: 'Configuration error: server mode misconfigured', zh: '設定錯誤：伺服器模式設定不完整' },
  'not found': { en: 'Not found', zh: '找不到這個頁面' },
  'bad request': { en: 'Bad request', zh: '請求格式錯誤' },
};
const STATUS_TEXT = {
  400: { en: 'Bad request', zh: '請求格式錯誤' }, 403: { en: 'Access denied', zh: '沒有權限' },
  404: { en: 'Not found', zh: '找不到這個頁面' }, 500: { en: 'Server error', zh: '伺服器錯誤' }, 503: { en: 'Service unavailable', zh: '服務暫時無法使用' },
};

/** detail: '' | string (shown once, as given) | { en, zh }. */
function page(status, message, detail) {
  const t = PAGE_TEXT[message] || { en: message, zh: (STATUS_TEXT[status] || STATUS_TEXT[500]).zh };
  const d = detail && typeof detail === 'object' ? detail : null;
  const plain = typeof detail === 'string' && detail && detail !== message ? detail : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.en)} · ${esc(t.zh)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222;background:#fff}
section+section{margin-top:2rem;padding-top:1rem;border-top:1px solid #8884}code{word-break:break-all}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#16181c}}a{color:inherit}</style></head>
<body><section><h1>${esc(t.en)}</h1>${d?.en ? `<p>${esc(d.en)}</p>` : ''}${plain ? `<p><code>${esc(plain)}</code></p>` : ''}<p><a href="/cdn-cgi/access/logout">Sign out</a></p></section>
<section lang="zh-Hant"><h1>${esc(t.zh)}</h1>${d?.zh ? `<p>${esc(d.zh)}</p>` : ''}<p><a href="/cdn-cgi/access/logout">登出</a></p></section></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** 403 / 404 / 500 as JSON for /api/* and non-navigation fetches, as a small bilingual HTML page for navigations. */
export function deny(request, status, message, detail = '') {
  const url = new URL(request.url);
  const wantsHtml = !url.pathname.startsWith('/api/') && (request.headers.get('accept') || '').includes('text/html');
  return wantsHtml ? page(status, message, detail) : errorJson(status, message);
}

/**
 * CSRF guard for mutating /api calls: a JSON content type (a cross-site form can only send text/plain, urlencoded or
 * multipart without a preflight) and a browser-set proof of same origin.
 */
export function sameOriginJson(request) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  if (request.headers.get('sec-fetch-site') === 'same-origin') return true;
  return request.headers.get('origin') === new URL(request.url).origin;
}

const TOO_LARGE = 'request body too large';

/** Body text, refusing more than maxBytes before reading (Content-Length) and while reading (chunked bodies). */
async function readCapped(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail(400, TOO_LARGE);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); fail(400, TOO_LARGE); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function readJson(request, maxBytes = 65536) {
  const text = await readCapped(request, maxBytes);
  try { return text ? JSON.parse(text) : {}; } catch { return fail(400, 'invalid JSON body'); }
}

export const nowIso = (now = Date.now()) => new Date(now).toISOString();

export const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
