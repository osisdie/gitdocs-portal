#!/usr/bin/env node
// Catalog management CLI.  npm run doc -- <command> …
import { loadCatalog, saveCatalog, syncCatalog, toRecord, findById, README_FIELDS, SENSITIVITIES } from './lib/catalog.mjs';
import { parseQuery, matchDoc, QUERY_HELP } from '../site/query.js';

const USAGE = `用法：npm run doc -- <指令>

  ls [查詢]                         列出文件（查詢語法同入口搜尋框，見下方）
  show <id>                         顯示一份文件的全部欄位
  set <id> key=value …              改欄位：title category status sensitivity desc url date
                                    （改 title/desc/url/date 會自動 lock；改 sensitivity 會標記為已複核）
  tag <id> +foo -bar baz            加／移除標籤（沒有前綴＝加）
  relate <id> <id2> [-<id3>]        建立關聯（-id 為移除）
  supersede <new> <old>             <new> 取代 <old>（加 --archive 把舊的狀態改成「封存」）
  lock <id> / unlock <id>           鎖定後 README 索引不再覆蓋 title/desc/url/date
  project <name> key=value …        改專案註冊表：title desc（子專案用 handbook/onboarding）
  kw ls | kw add <關鍵字> <regex…> | kw rm <關鍵字>
  filter ls | filter add <名稱> <查詢> | filter rm <名稱>

查詢語法：
${QUERY_HELP.map(([k, v]) => `  ${k.padEnd(32)}${v}`).join('\n')}`;

const [cmd, ...args] = process.argv.slice(2);
const die = (msg) => { console.error(msg); process.exit(1); };

// display width that counts CJK as 2 columns
const width = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const fit = (s, w) => {
  let out = '', n = 0;
  for (const ch of String(s ?? '')) { const cw = width(ch); if (n + cw > w - (width(String(s)) > w ? 1 : 0)) { out += '…'; n += 1; break; } out += ch; n += cw; }
  return out + ' '.repeat(Math.max(0, w - n));
};

function load() {
  const c = loadCatalog();
  const sync = syncCatalog(c);
  return { c, ...sync };
}
function need(c, id) {
  const hit = findById(c, id);
  if (!hit) die(`找不到編號 ${id}`);
  return hit;
}
function setField(c, entry, key, value) {
  const enums = { category: c.categories, status: c.statuses, sensitivity: SENSITIVITIES };
  const allowed = ['title', 'desc', 'url', 'date', ...Object.keys(enums)];
  if (!allowed.includes(key)) die(`不能改「${key}」。可改：${allowed.join(' ')}（project/subproject 由資料夾決定）`);
  if (enums[key] && !enums[key].includes(value)) die(`${key} 必須是：${enums[key].join(' / ')}`);
  if (key === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) die('date 格式：YYYY-MM-DD');
  entry[key] = value;
  if (README_FIELDS.includes(key)) entry.locked = true;
  if (key === 'sensitivity') entry.sensitivityReviewed = true;
}
const kv = (list) => list.map((a) => { const i = a.indexOf('='); if (i < 1) die(`參數要寫成 key=value：${a}`); return [a.slice(0, i), a.slice(i + 1)]; });

switch (cmd) {
  case 'ls': {
    const { items } = load();
    const q = parseQuery(args.join(' '));
    const rows = items.map((it) => ({ r: toRecord(it), m: matchDoc(toRecord(it), q, it.text) })).filter((x) => x.m)
      .sort((a, b) => b.r.date.localeCompare(a.r.date) || b.r.id - a.r.id);
    console.log(`${fit('編號', 8)}${fit('狀態', 8)}${fit('機敏', 8)}${fit('專案', 18)}${fit('分類', 12)}${fit('日期', 12)}標題`);
    for (const { r } of rows) console.log(`${fit(String(r.id).padStart(7, '0'), 8)}${fit(r.status, 8)}${fit(r.sensitivity, 8)}${fit(r.project + (r.subproject ? '/' + r.subproject : ''), 18)}${fit(r.category, 12)}${fit(r.date, 12)}${r.title}`);
    console.log(`— ${rows.length} / ${items.length} 份`);
    break;
  }
  case 'show': {
    const { c, items } = load();
    const { rel } = need(c, args[0]);
    const it = items.find((x) => x.rel === rel);
    const r = toRecord(it);
    for (const [k, v] of Object.entries(r)) console.log(`${fit(k, 20)}${Array.isArray(v) ? v.join(', ') : v}`);
    if (it.sensReasons.length) console.log(`${fit('(偵測到)', 20)}${it.sensReasons.join(', ')}`);
    break;
  }
  case 'set': {
    const { c } = load();
    const { entry } = need(c, args[0]);
    for (const [k, v] of kv(args.slice(1))) setField(c, entry, k, v);
    saveCatalog(c);
    console.log(`#${entry.id} 已更新${entry.locked ? '（locked）' : ''}`);
    break;
  }
  case 'tag': {
    const { c } = load();
    const { entry } = need(c, args[0]);
    const tags = new Set(entry.tags || []);
    for (const a of args.slice(1)) { if (a.startsWith('-')) tags.delete(a.slice(1)); else tags.add(a.replace(/^\+/, '')); }
    entry.tags = [...tags];
    saveCatalog(c);
    console.log(`#${entry.id} 標籤：${entry.tags.join(', ') || '（無）'}`);
    break;
  }
  case 'relate': {
    const { c } = load();
    const { entry } = need(c, args[0]);
    const rel = new Set(entry.related || []);
    for (const a of args.slice(1)) {
      const del = a.startsWith('-'); const other = need(c, a.replace(/^-/, '')).entry;
      if (other.id === entry.id) die('不能關聯自己');
      if (del) { rel.delete(other.id); other.related = (other.related || []).filter((x) => x !== entry.id); } else rel.add(other.id);
    }
    entry.related = [...rel].sort((a, b) => a - b);
    saveCatalog(c);
    console.log(`#${entry.id} 關聯：${entry.related.join(', ') || '（無）'}`);
    break;
  }
  case 'supersede': {
    const { c } = load();
    const nw = need(c, args[0]).entry, old = need(c, args[1]).entry;
    if (nw.id === old.id) die('不能取代自己');
    nw.supersedes = old.id;
    if (args.includes('--archive')) old.status = '封存';
    saveCatalog(c);
    console.log(`#${nw.id} 取代 #${old.id}${args.includes('--archive') ? '，#' + old.id + ' 已封存' : ''}`);
    break;
  }
  case 'lock': case 'unlock': {
    const { c } = load();
    const { entry } = need(c, args[0]);
    if (cmd === 'lock') entry.locked = true; else delete entry.locked;
    saveCatalog(c);
    console.log(`#${entry.id} ${cmd === 'lock' ? '已鎖定' : '已解鎖（下次 build 以 README 索引為準）'}`);
    break;
  }
  case 'project': {
    const { c } = load();
    const p = c.projects[args[0]] || die(`沒有專案「${args[0]}」。現有：${Object.keys(c.projects).join(', ')}`);
    for (const [k, v] of kv(args.slice(1))) { if (!['title', 'desc'].includes(k)) die('專案只能改 title / desc'); p[k] = v; }
    saveCatalog(c);
    console.log(`專案 ${args[0]} 已更新`);
    break;
  }
  case 'kw': {
    const { c } = load();
    const [sub, name, ...res] = args;
    if (sub === 'add') {
      if (!name || !res.length) die('kw add <關鍵字> <regex…>');
      for (const r of res) { try { new RegExp(r, 'i'); } catch (e) { die(`regex 無效：${r} (${e.message})`); } }
      c.keywords[name] = [...new Set([...(c.keywords[name] || []), ...res])];
    } else if (sub === 'rm') {
      if (!c.keywords[name]) die(`沒有關鍵字「${name}」`);
      delete c.keywords[name];
    } else {
      for (const [k, v] of Object.entries(c.keywords)) console.log(`${fit(k, 16)}${v.join('  ')}`);
      break;
    }
    saveCatalog(c);
    console.log(`關鍵字 ${name} 已${sub === 'add' ? '更新' : '刪除'}`);
    break;
  }
  case 'filter': {
    const { c } = load();
    const [sub, name, ...rest] = args;
    if (sub === 'add') {
      if (!name || !rest.length) die('filter add <名稱> <查詢>');
      c.filters = c.filters.filter((f) => f.name !== name).concat({ name, query: rest.join(' ') });
    } else if (sub === 'rm') {
      c.filters = c.filters.filter((f) => f.name !== name);
    } else {
      for (const f of c.filters) console.log(`${fit(f.name, 24)}${f.query}`);
      break;
    }
    saveCatalog(c);
    console.log(`篩選「${name}」已${sub === 'add' ? '儲存' : '刪除'}`);
    break;
  }
  default:
    console.log(USAGE);
    if (cmd && cmd !== 'help') process.exit(1);
}
