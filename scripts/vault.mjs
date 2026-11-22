#!/usr/bin/env node
// Vault CLI.  npm run vault -- <command> …
// Secrets live encrypted in <content>/vault/vault.json (safe to commit); documents keep only {{vault:<name>}}.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT, DOCS, VAULT_FILE, walk } from './lib/catalog.mjs';
import { NAME_RE, VAULT_RE, refsIn, createVault, deriveKey, exportKey, rekeyVault, seal, unseal, verifyKey } from '../site/vault-core.js';


const USAGE = `用法：npm run vault -- <指令>

  init                              建立空的 vault（密語取自 VAULT_PASSPHRASE，或互動輸入）
  ls                                列出 secret 名稱、備註、更新日、被哪些文件引用
  set <name> [--note=說明]          新增／更新（值從 stdin 讀，或互動隱藏輸入；不要放在指令列）
  get <name>                        印出明文
  rm <name>                         刪除（仍被文件引用時會拒絕，加 --force 強制）
  mv <old> <new>                    改名，並同步改寫文件裡的 {{vault:old}}
  rekey                             換密語（全部重新加密；新密語取自 VAULT_NEW_PASSPHRASE 或互動輸入）
  key                               印出由密語導出的 AES 金鑰（base64），給 server mode 的 VAULT_KEY secret 用
                                    （rekey 之後要重新設定）
  check                             檢查引用：文件裡的 {{vault:x}} 都要存在；有密語時也驗證能全部解開
  scan [--fix] [檔案…]               找文件裡的明文憑證；--fix 收進 vault 並改寫成 {{vault:…}}
  postman <檔案> [--prefix=名稱]     Postman environment／collection：secret 型別或像憑證的變數收進 vault

文件引用語法：{{vault:<name>}}，name 可用 A-Z a-z 0-9 _ . / -（例如 aws/prod/access-key）。
入口網站顯示成 •••••••• ，按「顯示」輸入密語才在瀏覽器端解密；明文不會進 git、dist、搜尋索引。`;

const [cmd, ...rawArgs] = process.argv.slice(2);
const flags = Object.fromEntries(rawArgs.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const args = rawArgs.filter((a) => !a.startsWith('--'));
const die = (msg) => { console.error(msg); process.exit(1); };
const today = () => new Date().toISOString().slice(0, 10);
const rel = (abs) => path.relative(CONTENT, abs).split(path.sep).join('/');

// ---------- env / prompts ----------
function loadDotEnv() {
  for (const dir of [...new Set([CONTENT, process.cwd()])]) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
loadDotEnv();

function promptHidden(question) {
  if (!process.stdin.isTTY) die(`${question.trim()} 需要互動輸入，或先設定環境變數。`);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(buf); }
      else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', onData);
  });
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
async function passphrase(envName = 'VAULT_PASSPHRASE', label = 'Vault 密語：') {
  if (process.env[envName]) return process.env[envName];
  return promptHidden(label);
}

// ---------- vault file ----------
function loadVault() {
  return fs.existsSync(VAULT_FILE) ? JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) : null;
}
function saveVault(v) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  v.secrets = Object.fromEntries(Object.entries(v.secrets).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(VAULT_FILE, JSON.stringify(v, null, 2) + '\n');
}
function needVault() {
  const v = loadVault();
  if (!v) die(`還沒有 vault：${rel(VAULT_FILE)}。先執行 npm run vault -- init`);
  return v;
}
async function unlock(v) {
  const key = await deriveKey(await passphrase(), v.kdf);
  if (!(await verifyKey(key, v))) die('密語錯誤。');
  return key;
}
const needName = (n) => { if (!n || !NAME_RE.test(n)) die(`secret 名稱只能用 A-Z a-z 0-9 _ . / -：${n ?? '(未提供)'}`); return n; };

// ---------- references in docs ----------
const docFiles = () => (fs.existsSync(DOCS) ? walk(DOCS, { notes: true }) : []); // notes too: they may quote credentials
function references() {
  const map = new Map(); // name → [rel…]
  for (const f of docFiles()) for (const n of refsIn(fs.readFileSync(f, 'utf8'))) map.set(n, [...(map.get(n) || []), rel(f)]);
  return map;
}

// ---------- plaintext detection (values are captured so they can be sealed) ----------
const SEAL_PATTERNS = [
  ['credential', /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|passw(?:or)?d|private[_-]?key|client[_-]?secret)\b(["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-/+.=]{16,})/gi, 3],
  ['private-key', /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g, 0],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}/g, 0],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g, 0],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g, 0],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g, 0],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 0],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g, 0],
];
/** [{ kind, value, index, label }] — non-overlapping, in file order. */
function findPlaintext(text) {
  const hits = [];
  for (const [kind, re, group] of SEAL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[group];
      const index = m.index + (group ? m[0].lastIndexOf(value) : 0);
      if (hits.some((h) => index < h.index + h.value.length && h.index < index + value.length)) continue;
      hits.push({ kind, value, index, label: group ? m[1].toLowerCase().replace(/[_]/g, '-') : kind });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
const slugOf = (f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/\.postman_(collection|environment)$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[^A-Za-z0-9_.-]+/g, '-').toLowerCase() || 'doc';
const mask = (s) => (s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-2)}`);

/** Seals values, reusing an existing secret when the same value is already stored. */
async function sealer(v, key) {
  const byValue = new Map();
  for (const [name, box] of Object.entries(v.secrets)) byValue.set(await unseal(key, name, box), name);
  return async (preferred, value, note) => {
    if (byValue.has(value)) return byValue.get(value);
    let name = preferred, i = 2;
    while (v.secrets[name]) name = `${preferred}-${i++}`;
    v.secrets[name] = { ...(await seal(key, name, value)), note, updated: today() };
    byValue.set(value, name);
    return name;
  };
}

// ---------- postman ----------
const POSTMAN_SECRET_KEY = /(token|secret|passw(or)?d|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|authorization|cookie|session)/i;
/** Visits every { key, value, type? } pair Postman uses for variables, environment values and auth params. */
function postmanPairs(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => postmanPairs(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.key === 'string' && typeof node.value === 'string') out.push(node);
    for (const [k, val] of Object.entries(node)) if (k !== 'value') postmanPairs(val, out);
  }
  return out;
}

// ---------- commands ----------
switch (cmd) {
  case 'init': {
    if (loadVault()) die(`已經有 vault：${rel(VAULT_FILE)}`);
    let pass = process.env.VAULT_PASSPHRASE;
    if (!pass) {
      pass = await promptHidden('設定 vault 密語：');
      if (pass !== await promptHidden('再輸入一次：')) die('兩次輸入不同。');
    }
    if (pass.length < 12) die('密語至少 12 個字元（建議 4 個以上的單字）。');
    const { vault } = await createVault(pass);
    saveVault(vault);
    console.log(`已建立 ${rel(VAULT_FILE)}（PBKDF2 ${vault.kdf.iterations.toLocaleString()} 次 → AES-256-GCM）。這個檔案可以 commit；密語不要 commit。`);
    break;
  }
  case 'ls': {
    const v = needVault();
    const refs = references();
    const names = [...new Set([...Object.keys(v.secrets), ...refs.keys()])].sort();
    if (!names.length) { console.log('（vault 是空的）'); break; }
    for (const n of names) {
      const s = v.secrets[n];
      const used = refs.get(n) || [];
      console.log(`${s ? '  ' : '✗ '}${n.padEnd(36)} ${(s?.updated || '缺少').padEnd(11)} ${used.length ? `引用 ${used.length}：${used.join(', ')}` : '（沒有文件引用）'}${s?.note ? `  — ${s.note}` : ''}`);
    }
    break;
  }
  case 'set': {
    const name = needName(args[0]);
    const v = needVault();
    const key = await unlock(v);
    const value = process.stdin.isTTY ? await promptHidden(`${name} 的值：`) : await readStdin();
    if (!value) die('值是空的。');
    v.secrets[name] = { ...(await seal(key, name, value)), note: flags.note ?? v.secrets[name]?.note ?? '', updated: today() };
    saveVault(v);
    console.log(`已寫入 ${name}。文件中引用：{{vault:${name}}}`);
    break;
  }
  case 'get': {
    const name = needName(args[0]);
    const v = needVault();
    if (!v.secrets[name]) die(`沒有 ${name}`);
    process.stdout.write(await unseal(await unlock(v), name, v.secrets[name]) + (process.stdout.isTTY ? '\n' : ''));
    break;
  }
  case 'rm': {
    const name = needName(args[0]);
    const v = needVault();
    if (!v.secrets[name]) die(`沒有 ${name}`);
    const used = references().get(name) || [];
    if (used.length && !flags.force) die(`${name} 仍被引用：${used.join(', ')}（加 --force 強制刪除）`);
    delete v.secrets[name];
    saveVault(v);
    console.log(`已刪除 ${name}`);
    break;
  }
  case 'mv': {
    const [from, to] = [needName(args[0]), needName(args[1])];
    const v = needVault();
    if (!v.secrets[from]) die(`沒有 ${from}`);
    if (v.secrets[to]) die(`${to} 已存在`);
    const key = await unlock(v);
    v.secrets[to] = { ...v.secrets[from], ...(await seal(key, to, await unseal(key, from, v.secrets[from]))), updated: today() };
    delete v.secrets[from];
    saveVault(v);
    let files = 0;
    for (const f of docFiles()) {
      const t = fs.readFileSync(f, 'utf8');
      const n = t.replace(VAULT_RE, (m, name) => (name === from ? `{{vault:${to}}}` : m));
      if (n !== t) { fs.writeFileSync(f, n); files++; }
    }
    console.log(`${from} → ${to}；改寫 ${files} 份文件。`);
    break;
  }
  case 'rekey': {
    const v = needVault();
    const key = await unlock(v);
    let next = process.env.VAULT_NEW_PASSPHRASE;
    if (!next) {
      next = await promptHidden('新密語：');
      if (next !== await promptHidden('再輸入一次：')) die('兩次輸入不同。');
    }
    if (next.length < 12) die('密語至少 12 個字元。');
    const { vault } = await rekeyVault(v, key, next);
    saveVault(vault);
    console.log(`已用新密語重新加密 ${Object.keys(vault.secrets).length} 筆。記得更新 .env 的 VAULT_PASSPHRASE；server mode 也要重設 VAULT_KEY（npm run vault -- key）。`);
    break;
  }
  case 'key': {
    const v = needVault();
    const key = await deriveKey(await passphrase(), v.kdf, true);
    if (!(await verifyKey(key, v))) die('密語錯誤。');
    process.stdout.write(await exportKey(key) + (process.stdout.isTTY ? '\n' : ''));
    break;
  }
  case 'check': {
    const v = loadVault();
    const refs = references();
    const missing = [...refs.keys()].filter((n) => !v?.secrets[n]);
    for (const n of missing) console.error(`✗ 缺少 secret「${n}」：${refs.get(n).join(', ')}`);
    let leaks = 0;
    for (const f of docFiles()) for (const h of findPlaintext(fs.readFileSync(f, 'utf8'))) { leaks++; console.error(`✗ 明文憑證 ${h.kind} ${mask(h.value)}：${rel(f)}`); }
    if (v && process.env.VAULT_PASSPHRASE) {
      const key = await unlock(v);
      for (const [n, box] of Object.entries(v.secrets)) await unseal(key, n, box).catch(() => die(`✗ 無法解開 ${n}（密文損壞或被搬動）`));
      console.log(`✓ 密語正確，${Object.keys(v.secrets).length} 筆都能解開`);
    }
    if (missing.length || leaks) die(`check 失敗：缺少 ${missing.length}、明文 ${leaks}（npm run vault -- scan --fix 可收進 vault）`);
    console.log(`✓ ${refs.size} 個引用都存在${v ? `，vault 共 ${Object.keys(v.secrets).length} 筆` : ''}；沒有偵測到明文憑證`);
    break;
  }
  case 'scan': {
    const files = args.length ? args.map((a) => path.resolve(a)).flatMap((a) => (fs.statSync(a).isDirectory() ? walk(a) : [a])) : docFiles();
    const found = files.map((f) => ({ f, hits: findPlaintext(fs.readFileSync(f, 'utf8')) })).filter((x) => x.hits.length);
    if (!found.length) { console.log('沒有偵測到明文憑證。'); break; }
    for (const { f, hits } of found) for (const h of hits) console.log(`${rel(f)}  ${h.kind.padEnd(16)} ${mask(h.value)}`);
    if (!flags.fix) { console.log(`\n共 ${found.reduce((n, x) => n + x.hits.length, 0)} 處。加 --fix 收進 vault 並改寫成 {{vault:…}}。`); break; }
    const v = needVault();
    const put = await sealer(v, await unlock(v));
    for (const { f, hits } of found) {
      let text = fs.readFileSync(f, 'utf8');
      for (const h of [...hits].reverse()) { // right-to-left keeps earlier indexes valid
        const dir = path.relative(DOCS, path.dirname(f)).split(path.sep).filter((x) => x && x !== '..').join('/');
        const name = await put(`${dir ? dir + '/' : ''}${slugOf(f)}/${h.label}`, h.value, `scan --fix ${rel(f)}`);
        text = text.slice(0, h.index) + `{{vault:${name}}}` + text.slice(h.index + h.value.length);
      }
      fs.writeFileSync(f, text);
      console.log(`✓ ${rel(f)}：${hits.length} 處改成 vault 引用`);
    }
    saveVault(v);
    break;
  }
  case 'postman': {
    if (!args[0]) die('用法：npm run vault -- postman <檔案> [--prefix=名稱]');
    const file = path.resolve(args[0]);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prefix = `postman/${flags.prefix || slugOf(file)}`;
    const pairs = postmanPairs(doc).filter((p) => p.value && !/\{\{\s*vault:/.test(p.value) && (p.type === 'secret' || POSTMAN_SECRET_KEY.test(p.key)));
    if (!pairs.length) { console.log('沒有需要收進 vault 的變數。'); break; }
    const v = needVault();
    const put = await sealer(v, await unlock(v));
    for (const p of pairs) {
      const name = await put(`${prefix}/${p.key.replace(/[^A-Za-z0-9_.-]+/g, '-')}`, p.value, `postman ${rel(file)} · ${p.key}`);
      p.value = `{{vault:${name}}}`;
      console.log(`✓ ${p.key} → {{vault:${name}}}`);
    }
    saveVault(v);
    fs.writeFileSync(file, JSON.stringify(doc, null, '\t') + '\n');
    console.log(`改寫 ${rel(file)}：${pairs.length} 個變數。匯回 Postman 前用 npm run vault -- get <name> 取值，或在 Postman 端另設 secret。`);
    break;
  }
  default:
    console.log(USAGE);
    if (cmd && cmd !== 'help') process.exit(1);
}
