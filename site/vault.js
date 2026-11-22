// Vault reveal widget. Replaces {{vault:<name>}} in text with a masked field (••••••••) that can be revealed or
// copied after the viewer enters the vault passphrase. Decryption happens in the browser; the derived key is kept in
// sessionStorage (this tab only) until "鎖定" or the tab closes. Loaded by the portal (import) and injected by the
// build into HTML docs that contain vault fields, where it runs on its own.
import { VAULT_RE, deriveKey, exportKey, importKey, unseal, verifyKey } from './vault-core.js';

const SS_KEY = 'gitdocs:vault-key';
const REMASK_MS = 30000;
const DOTS = '••••••••';
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE']);
let vaultP = null;
let keyP = null;

const ssGet = () => { try { return sessionStorage.getItem(SS_KEY); } catch { return null; } };
const ssSet = (v) => { try { v ? sessionStorage.setItem(SS_KEY, v) : sessionStorage.removeItem(SS_KEY); } catch { /* storage blocked */ } };
const loadVault = () => (vaultP ||= fetch('/vault.json', { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error('這個入口沒有部署 vault（或沒有權限）。');
  return r.json();
}).catch((e) => { vaultP = null; throw e; }));

export const isUnlocked = () => Boolean(ssGet());
export function lock() {
  ssSet(null); keyP = null;
  document.querySelectorAll('.gdv[data-shown]').forEach(hide);
  document.dispatchEvent(new CustomEvent('gitdocs:vault', { detail: { unlocked: false } }));
}

function css() {
  if (document.getElementById('gdv-style')) return;
  const s = document.createElement('style');
  s.id = 'gdv-style';
  s.textContent = `
.gdv{display:inline-flex;align-items:center;gap:.3em;padding:0 .3em;border:1px dashed currentColor;border-radius:4px;font:inherit;white-space:nowrap;vertical-align:baseline;opacity:.9}
.gdv-v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em}
.gdv[data-shown] .gdv-v{white-space:pre-wrap;word-break:break-all}
.gdv button{font:600 11px/1.4 system-ui,sans-serif;padding:0 .45em;border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.75}
.gdv button:hover,.gdv button:focus-visible{opacity:1}
.gdv-dlg{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.45);font:14px/1.5 system-ui,sans-serif}
.gdv-dlg form{background:#fff;color:#1b1f24;border-radius:10px;padding:18px 20px;width:min(360px,calc(100vw - 32px));box-shadow:0 12px 40px rgba(0,0,0,.3)}
.gdv-dlg h2{margin:0 0 4px;font-size:16px}.gdv-dlg p{margin:0 0 12px;color:#57606a;font-size:13px}
.gdv-dlg input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #8c959f;border-radius:6px;font:inherit}
.gdv-dlg .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.gdv-dlg button{padding:6px 14px;border-radius:6px;border:1px solid #8c959f;background:#f6f8fa;font:inherit;cursor:pointer}
.gdv-dlg button[type=submit]{background:#245c73;border-color:#245c73;color:#fff}
.gdv-dlg .err{color:#cf222e;min-height:1.2em;margin:8px 0 0;font-size:13px}
@media (prefers-color-scheme:dark){.gdv-dlg form{background:#1f242b;color:#e6edf3}.gdv-dlg p{color:#9da7b3}.gdv-dlg input,.gdv-dlg button{background:#0d1117;color:#e6edf3;border-color:#3d444d}}`;
  document.head.appendChild(s);
}

function askPassphrase(vault) {
  return new Promise((resolve, reject) => {
    const wrap = document.createElement('div');
    wrap.className = 'gdv-dlg';
    wrap.innerHTML = `<form role="dialog" aria-modal="true" aria-labelledby="gdv-t">
      <h2 id="gdv-t">解鎖 vault</h2><p>輸入 vault 密語。在瀏覽器端解密，關閉分頁或按「鎖定」後失效。</p>
      <input type="password" autocomplete="off" spellcheck="false" aria-label="vault 密語" required>
      <div class="err" aria-live="polite"></div>
      <div class="row"><button type="button" data-x>取消</button><button type="submit">解鎖</button></div></form>`;
    const form = wrap.querySelector('form'), input = wrap.querySelector('input'), err = wrap.querySelector('.err');
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { close(); reject(new Error('cancelled')); } };
    wrap.querySelector('[data-x]').addEventListener('click', () => { close(); reject(new Error('cancelled')); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '驗證中…';
      try {
        const key = await deriveKey(input.value, vault.kdf, true);
        if (!(await verifyKey(key, vault))) { err.textContent = '密語錯誤。'; input.select(); return; }
        ssSet(await exportKey(key));
        close();
        resolve(await importKey(ssGet()));
        document.dispatchEvent(new CustomEvent('gitdocs:vault', { detail: { unlocked: true } }));
      } catch (x) { err.textContent = `無法解鎖：${x.message}`; }
    });
    document.addEventListener('keydown', onKey, true);
    css();
    document.body.appendChild(wrap);
    input.focus();
  });
}

async function getKey() {
  const vault = await loadVault();
  const raw = ssGet();
  if (raw) {
    const key = await importKey(raw);
    if (await verifyKey(key, vault)) return key;
    ssSet(null); // vault was rekeyed since this tab unlocked
  }
  keyP ||= askPassphrase(vault).finally(() => { keyP = null; });
  return keyP;
}

async function reveal(name) {
  const vault = await loadVault();
  const box = vault.secrets?.[name];
  if (!box) throw new Error(`vault 裡沒有「${name}」`);
  return unseal(await getKey(), name, box);
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
  el.innerHTML = '<span class="gdv-v"></span><button type="button" data-a="show">顯示</button><button type="button" data-a="copy">複製</button>';
  el.querySelector('.gdv-v').textContent = DOTS;
  el.querySelector('[data-a=show]').setAttribute('aria-label', `顯示 ${name}`);
  el.querySelector('[data-a=copy]').setAttribute('aria-label', `複製 ${name}`);
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
        el.querySelector('.gdv-v').textContent = value;
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
export function mask(root = document.body) {
  if (!root) return 0;
  css();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentNode; p && p !== root.parentNode; p = p.parentNode) if (SKIP.has(p.nodeName) || p.classList?.contains('gdv')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.includes('{{') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const n of nodes) {
    const text = n.nodeValue;
    VAULT_RE.lastIndex = 0;
    if (!VAULT_RE.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(VAULT_RE)) {
      frag.append(text.slice(last, m.index), widget(m[1]));
      last = m.index + m[0].length;
      count++;
    }
    frag.append(text.slice(last));
    n.replaceWith(frag);
  }
  return count;
}

// Standalone docs (not the portal shell): mask on load.
if (!document.documentElement.hasAttribute('data-gitdocs-portal')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mask());
  else mask();
}
