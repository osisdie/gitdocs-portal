// Vault UI for the portal shell (never loaded by documents).
//  • mask(root)          — replaces {{vault:<name>}} text in portal-rendered previews (Markdown / text / JSON) with a
//                          masked field whose 顯示 / 複製 buttons decrypt in place.
//  • revealDialog(name)  — portal-owned dialog used when a sandboxed HTML document asks (postMessage) to show a field;
//                          the plaintext is shown here and never handed to the document.
// The key is a non-extractable CryptoKey held in memory only: it survives in-app navigation, not reloads.
import { VAULT_RE, deriveKey, unseal, verifyKey } from './vault-core.js';

const REMASK_MS = 30000;
const DOTS = '••••••••';
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE']);
let vaultP = null;
let key = null;
let keyP = null;

const emit = () => document.dispatchEvent(new CustomEvent('gitdocs:vault', { detail: { unlocked: Boolean(key) } }));
const loadVault = () => (vaultP ||= fetch('vault.json', { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error('這個入口沒有部署 vault。');
  return r.json();
}).catch((e) => { vaultP = null; throw e; }));

export const isUnlocked = () => Boolean(key);
export function lock() {
  key = null; keyP = null;
  document.querySelectorAll('.gdv[data-shown]').forEach(hide);
  document.querySelectorAll('.gdv-dlg').forEach((d) => d.remove());
  emit();
}

function css() {
  if (document.getElementById('gdv-style')) return;
  const s = document.createElement('style');
  s.id = 'gdv-style';
  s.textContent = `
.gdv{display:inline-flex;align-items:center;gap:.3em;padding:0 .3em;border:1px dashed currentColor;border-radius:4px;white-space:nowrap;opacity:.9}
.gdv-v{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);letter-spacing:.04em}
.gdv[data-shown] .gdv-v{white-space:pre-wrap;word-break:break-all}
.gdv button{font:600 11px/1.4 system-ui,sans-serif;padding:0 .45em;border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.75}
.gdv button:hover,.gdv button:focus-visible{opacity:1}
.gdv-dlg{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:16px}
.gdv-dlg form{background:var(--surface,#fff);color:var(--text,#1b1f24);border:1px solid var(--border,#d0d7de);border-radius:10px;padding:18px 20px;width:min(420px,100%);box-shadow:0 12px 40px rgba(0,0,0,.3)}
.gdv-dlg h2{margin:0 0 4px;font-size:16px}.gdv-dlg p{margin:0 0 12px;color:var(--muted,#57606a);font-size:13px}
.gdv-dlg input,.gdv-dlg output{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#8c959f);border-radius:6px;font:inherit;background:var(--bg,#fff);color:inherit}
.gdv-dlg output{font-family:var(--mono,ui-monospace,monospace);white-space:pre-wrap;word-break:break-all;min-height:2.4em}
.gdv-dlg .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.gdv-dlg button{padding:6px 14px;border-radius:6px;border:1px solid var(--border,#8c959f);background:transparent;color:inherit;font:inherit;cursor:pointer}
.gdv-dlg button.pri{background:var(--accent,#245c73);border-color:var(--accent,#245c73);color:#fff}
.gdv-dlg .err{color:#cf222e;min-height:1.2em;margin:8px 0 0;font-size:13px}`;
  document.head.appendChild(s);
}

/** Generic modal; `build(form, close)` fills it. Escape / 取消 closes. */
function modal(build) {
  css();
  const wrap = document.createElement('div');
  wrap.className = 'gdv-dlg';
  const form = document.createElement('form');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  wrap.appendChild(form);
  const prev = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { wrap.remove(); document.removeEventListener('keydown', onKey, true); wrap.dispatchEvent(new Event('close')); prev?.focus?.(); }
  document.addEventListener('keydown', onKey, true);
  build(form, close, wrap);
  document.body.appendChild(wrap);
  return { wrap, close };
}

function askPassphrase(vault) {
  return new Promise((resolve, reject) => {
    const { wrap } = modal((form, close) => {
      form.innerHTML = `<h2>解鎖 vault</h2><p>輸入 vault 密語。在瀏覽器端解密，重新整理或按「鎖定 vault」後失效。</p>
        <input type="password" autocomplete="off" spellcheck="false" aria-label="vault 密語" required>
        <div class="err" aria-live="polite"></div>
        <div class="row"><button type="button" data-x>取消</button><button type="submit" class="pri">解鎖</button></div>`;
      const input = form.querySelector('input'), err = form.querySelector('.err');
      form.querySelector('[data-x]').addEventListener('click', close);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '驗證中…';
        try {
          const k = await deriveKey(input.value, vault.kdf, false);
          if (!(await verifyKey(k, vault))) { err.textContent = '密語錯誤。'; input.select(); return; }
          key = k; emit(); resolve(k); close();
        } catch (x) { err.textContent = `無法解鎖：${x.message}`; }
      });
      setTimeout(() => input.focus());
    });
    wrap.addEventListener('close', () => { if (!key) reject(new Error('cancelled')); });
  });
}

async function getKey() {
  if (key) return key;
  const vault = await loadVault();
  keyP ||= askPassphrase(vault).finally(() => { keyP = null; });
  return keyP;
}

async function reveal(name) {
  const box = (await loadVault()).secrets?.[name];
  if (!box) throw new Error(`vault 裡沒有「${name}」`);
  return unseal(await getKey(), name, box);
}

/** Portal-owned dialog showing one secret (used for sandboxed HTML documents). */
export async function revealDialog(name, from = '') {
  let value;
  try { value = await reveal(name); } catch (x) { if (x.message !== 'cancelled') alert(x.message); return; }
  modal((form, close) => {
    form.innerHTML = `<h2></h2><p></p><output></output>
      <div class="row"><button type="button" data-c>複製</button><button type="button" class="pri" data-x>關閉</button></div>`;
    form.querySelector('h2').textContent = `vault：${name}`;
    form.querySelector('p').textContent = from ? `文件「${from}」要求顯示這個欄位。30 秒後自動關閉。` : '30 秒後自動關閉。';
    form.querySelector('output').textContent = value;
    const c = form.querySelector('[data-c]');
    c.addEventListener('click', async () => { await navigator.clipboard.writeText(value); c.textContent = '已複製'; });
    form.querySelector('[data-x]').addEventListener('click', close);
    const t = setTimeout(close, REMASK_MS);
    form.addEventListener('submit', (e) => e.preventDefault());
    form.closest('.gdv-dlg').addEventListener('close', () => clearTimeout(t));
    setTimeout(() => form.querySelector('[data-x]').focus());
  });
}

function hide(el) {
  clearTimeout(el._t);
  delete el.dataset.shown;
  el.querySelector('.gdv-v').textContent = DOTS;
  el.querySelector('[data-a=show]').textContent = '顯示';
}

function widget(name) {
  const el = document.createElement('span');
  el.className = 'gdv';
  el.dataset.vault = name;
  el.title = `vault：${name}`;
  const v = document.createElement('span');
  v.className = 'gdv-v';
  v.textContent = DOTS;
  el.append(v);
  for (const [a, label] of [['show', '顯示'], ['copy', '複製']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.a = a; b.textContent = label; b.setAttribute('aria-label', `${label} ${name}`);
    el.append(b);
  }
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.a === 'show' && el.dataset.shown !== undefined) { hide(el); return; }
    try {
      const value = await reveal(name);
      if (b.dataset.a === 'copy') {
        await navigator.clipboard.writeText(value);
        b.textContent = '已複製'; setTimeout(() => { b.textContent = '複製'; }, 1500);
      } else {
        el.dataset.shown = '';
        v.textContent = value;
        b.textContent = '隱藏';
        el._t = setTimeout(() => hide(el), REMASK_MS);
      }
    } catch (x) {
      if (x.message !== 'cancelled') { b.textContent = '失敗'; b.title = x.message; setTimeout(() => { b.textContent = b.dataset.a === 'copy' ? '複製' : '顯示'; }, 2500); }
    }
  });
  return el;
}

/** Replace every {{vault:name}} text occurrence under `root` with a masked widget. Returns the number replaced. */
export function mask(root) {
  if (!root) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentNode; p && p !== root; p = p.parentNode) if (SKIP.has(p.nodeName) || p.classList?.contains('gdv')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.includes('{{') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const n of nodes) {
    const text = n.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(VAULT_RE)) {
      frag.append(text.slice(last, m.index), widget(m[1]));
      last = m.index + m[0].length;
      count++;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    n.replaceWith(frag);
  }
  if (count) css();
  return count;
}
