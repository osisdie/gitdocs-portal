// UI language: message lookup, label maps for stored enum values, and locale-aware formatting.
// Pure ES module (no DOM access at import time), so Node can import it through query.js / model.js.
//
//   t(key, params)   plain text; `{name}` placeholders are replaced verbatim (use for textContent, alert, attributes
//                    that are escaped anyway)
//   th(key, params)  HTML: the message is trusted markup, every param is escaped unless wrapped in raw()
//   label(kind, v)   display label of a stored value (status / sens / cat / project); unknown values pass through
//
// Messages are strings, or plural objects { one, other, zero? } chosen by Intl.PluralRules on params.n.
// Data stays as stored (Chinese enum values in catalog.json and D1); only its display goes through label().
import en from './i18n/en.js';
import zhTW from './i18n/zh-TW.js';

export const LANGS = { en: 'English', 'zh-TW': '繁體中文' };
export const DEFAULT_LANG = 'en';
export const LANG_KEY = 'gitdocs:lang'; // localStorage key (static mode, and the first-paint mirror in server mode)
const CATALOGS = { en, 'zh-TW': zhTW };
export const catalogs = () => CATALOGS;

let lang = DEFAULT_LANG;

/** 'zh', 'zh-Hant', 'zh_tw' → 'zh-TW'; 'en-GB' → 'en'; anything else → null. */
export function normLang(x) {
  const v = String(x || '').trim().toLowerCase().replace('_', '-');
  if (!v) return null;
  if (v === 'zh' || v.startsWith('zh-')) return 'zh-TW';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return null;
}
export const getLang = () => lang;
/** Switch the active language (unknown → default). Updates <html lang> when there is a document. */
export function setLang(l) {
  lang = normLang(l) || DEFAULT_LANG;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}
/** BCP 47 tag for Intl formatters. */
export const intlLocale = (l = lang) => (l === 'zh-TW' ? 'zh-TW' : 'en');

const plural = new Map();
function pick(msg, params, l) {
  if (typeof msg !== 'object' || msg === null) return msg;
  const n = Number(params?.n);
  if (n === 0 && msg.zero !== undefined) return msg.zero;
  if (!plural.has(l)) plural.set(l, new Intl.PluralRules(intlLocale(l)));
  return msg[plural.get(l).select(Number.isFinite(n) ? n : 0)] ?? msg.other;
}
function lookup(l, key, params) {
  const msg = CATALOGS[l]?.[key] ?? CATALOGS[DEFAULT_LANG][key];
  return msg === undefined ? key : pick(msg, params, CATALOGS[l]?.[key] !== undefined ? l : DEFAULT_LANG);
}
const fill = (s, params, f) => String(s).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? f(params[k]) : m));

/** Message in an explicit language (for Node callers such as the CLI help). */
export const tl = (l, key, params) => fill(lookup(normLang(l) || DEFAULT_LANG, key, params), params, String);
/** Message in the active language, params inserted as-is. */
export const t = (key, params) => fill(lookup(lang, key, params), params, String);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Mark an already-safe HTML fragment so th() inserts it unescaped. */
export const raw = (html) => ({ __html: String(html) });
/** Message in the active language as HTML: the message is trusted, params are escaped unless raw(). */
export const th = (key, params) => fill(lookup(lang, key, params), params, (v) => (v && typeof v === 'object' && '__html' in v ? v.__html : esc(v)));

// ---------- stored enum values ----------
// Stored value → stable slug. Labels are the catalog keys `<kind>.<slug>`; the slugs double as English query aliases
// (query.js). The zh-TW labels equal the stored values.
export const ENUMS = {
  status: {
    '待處理': 'open', '待確認': 'in-review', '已確認': 'confirmed', '已發布': 'published', '封存': 'archived',
    // legacy values (migrated by the next build)
    '草稿': 'draft', '審查中': 'under-review', '本機': 'local',
  },
  sens: { '公開': 'public', '內部': 'internal', '機密': 'confidential', '極機密': 'secret' },
  cat: {
    '計畫': 'plan', '評估': 'evaluation', '比較': 'comparison', '稽核': 'audit', '設計／UX': 'design-ux', '表單': 'form',
    'API': 'api', '技能手冊': 'playbook', '劇本／文案': 'script-copy', '腳本': 'shell-script', '索引': 'index', '報告': 'report',
  },
  project: { '（索引）': 'index' },
};
// Extra query aliases (lower-case) → slug.
const EXTRA_ALIASES = {
  status: { review: 'in-review', todo: 'open', new: 'open', done: 'confirmed', closed: 'archived' },
  sens: { 'top-secret': 'secret', private: 'confidential' },
  cat: { eval: 'evaluation', compare: 'comparison', design: 'design-ux', ux: 'design-ux', copy: 'script-copy', shell: 'shell-script', sh: 'shell-script' },
  project: {},
};

/** Display label of a stored value in the active language; unknown (custom) values are returned unchanged. */
export function label(kind, value, l = lang) {
  const slug = ENUMS[kind]?.[value];
  if (!slug) return value ?? '';
  const k = `${kind}.${slug}`;
  return CATALOGS[l]?.[k] ?? CATALOGS[DEFAULT_LANG][k] ?? value;
}

const aliasCache = {};
/** Stored value for a query alias: the stored value itself, its slug, its English label, or an extra alias (case-insensitive). */
export function enumValue(kind, input) {
  const table = ENUMS[kind];
  if (!table) return null;
  if (!aliasCache[kind]) {
    const m = new Map();
    for (const [stored, slug] of Object.entries(table)) {
      m.set(stored.toLowerCase(), stored);
      m.set(slug, stored);
      m.set(String(label(kind, stored, 'en')).toLowerCase(), stored);
    }
    const bySlug = Object.fromEntries(Object.entries(table).map(([s, slug]) => [slug, s]));
    for (const [a, slug] of Object.entries(EXTRA_ALIASES[kind] || {})) if (!m.has(a)) m.set(a, bySlug[slug]);
    aliasCache[kind] = m;
  }
  return aliasCache[kind].get(String(input ?? '').trim().toLowerCase()) || null;
}
/** Every searchable name of a stored value: itself, its slug and its English label (lower-case). */
export function enumNames(kind, stored) {
  const slug = ENUMS[kind]?.[stored];
  const names = [String(stored ?? '').toLowerCase()];
  if (slug) names.push(slug, String(label(kind, stored, 'en')).toLowerCase());
  return names;
}

// ---------- server messages ----------
// functions/ answers some errors in Chinese; show them in the active language.
const SERVER_ERRORS = {
  '尚未開通，請聯絡管理員': 'srv.notEnabled',
  '需要 editor 權限': 'srv.needEditor',
  '需要 manager 權限': 'srv.needManager',
  '需要 owner 權限': 'srv.needOwner',
  '沒有權限檢視這份文件': 'srv.noDocAccess',
};
export const serverMessage = (msg) => (SERVER_ERRORS[msg] ? t(SERVER_ERRORS[msg]) : msg);

// ---------- formatting ----------
/** ISO timestamp → localized date + time (24 h); unparsable input is returned unchanged. */
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (iso == null || iso === '' || Number.isNaN(d.getTime())) return String(iso ?? '');
  return d.toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
}
/** Join a list the way the active language does ('a, b' / 'a、b'). */
export const joinList = (items) => items.join(t('sep.list'));
