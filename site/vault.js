// Vault UI for the portal shell (never loaded by documents).
//  • mask(root)          — replaces {{vault:<name>}} text in portal-rendered previews (Markdown / text / JSON) with a
//                          masked field whose 顯示 / 複製 buttons decrypt in place.
//  • revealDialog(name)  — portal-owned dialog used when a sandboxed HTML document asks (postMessage) to show a field;
//                          it opens masked and decrypts only on the user's click; the plaintext is never handed to
//                          the document.
// Static mode: the key is a non-extractable CryptoKey held in memory only (survives in-app navigation, not reloads).
// Server mode (useServer): no passphrase and no key in the browser — POST /api/vault/reveal checks the role, audits
// the access and returns one value; viewers get the mask with disabled buttons.
import { VAULT_RE, deriveKey, unseal, verifyKey } from './vault-core.js';
import { api } from './api.js';

const REMASK_MS = 30000;
const DOTS = '••••••••';
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE']);
let vaultP = null;
let key = null;
let keyP = null;
let server = null; // { canReveal(docId) } in server mode
export const NO_ROLE = '需要 editor 權限';

/** Switch to the server vault. `canReveal(docId)` decides whether the buttons are enabled for that document. */
export function useServer(opts) { server = opts; }
export const isServerVault = () => Boolean(server);

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
.gdv button:disabled{cursor:not-allowed;opacity:.4}
.gdv-dlg{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:16px}
.gdv-dlg form{background:var(--surface,#fff);color:var(--fg,#1b1f24);border:1px solid var(--line,#d0d7de);border-radius:10px;padding:18px 20px;width:min(420px,100%);box-shadow:0 12px 40px rgba(0,0,0,.3)}
.gdv-dlg h2{margin:0 0 4px;font-size:16px}.gdv-dlg p{margin:0 0 12px;color:var(--muted,#57606a);font-size:13px}
.gdv-dlg input,.gdv-dlg output{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#8c959f);border-radius:6px;font:inherit;background:var(--bg,#fff);color:inherit}
.gdv-dlg output{font-family:var(--mono,ui-monospace,monospace);white-space:pre-wrap;word-break:break-all;min-height:2.4em}
.gdv-dlg .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.gdv-dlg button{padding:6px 14px;border-radius:6px;border:1px solid var(--line,#8c959f);background:transparent;color:inherit;font:inherit;cursor:pointer}
.gdv-dlg button.pri{background:var(--accent,#245c73);border-color:var(--accent,#245c73);color:var(--accent-fg,#fff)}
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

async function reveal(name, id, action = 'show') {
  if (server) {
    if (!server.canReveal(id)) throw new Error(NO_ROLE);
    const r = await api('POST', '/api/vault/reveal', { id: Number(id), name, action });
    if (typeof r?.value !== 'string') throw new Error('伺服器沒有回傳值。');
    return r.value;
  }
  const box = (await loadVault()).secrets?.[name];
  if (!box) throw new Error(`vault 裡沒有「${name}」`);
  return unseal(await getKey(), name, box);
}

/**
 * Portal-owned dialog for one secret, opened when a sandboxed HTML document asks (postMessage). It opens masked: a
 * document can ask, but only the user's click on 顯示 / 複製 reveals (and, in server mode, audits). While one is open
 * further requests are ignored, so a document cannot stack or spam dialogs.
 */
export function revealDialog(name, from = '', id = null) {
  if (document.querySelector('.gdv-dlg[data-reveal]')) return false;
  const allowed = !server || server.canReveal(id);
  modal((form, close, wrap) => {
    wrap.dataset.reveal = '';
    form.innerHTML = `<h2></h2><p></p><output></output><div class="err" aria-live="polite"></div>
      <div class="row"><button type="button" data-a="show">顯示</button><button type="button" data-a="copy">複製</button><button type="button" class="pri" data-x>關閉</button></div>`;
    form.querySelector('h2').textContent = `vault：${name}`;
    form.querySelector('p').textContent = from ? `文件「${from}」要求顯示這個欄位。按「顯示」或「複製」才會解密。` : '按「顯示」或「複製」才會解密。';
    const out = form.querySelector('output'), err = form.querySelector('.err');
    out.textContent = DOTS;
    let t = null;
    for (const b of form.querySelectorAll('[data-a]')) {
      if (!allowed) { b.disabled = true; b.title = NO_ROLE; }
      b.addEventListener('click', async () => {
        err.textContent = '';
        try {
          const value = await reveal(name, id, b.dataset.a);
          if (!wrap.isConnected) return;
          if (b.dataset.a === 'copy') { await navigator.clipboard.writeText(value); b.textContent = '已複製'; return; }
          out.textContent = value;
          clearTimeout(t);
          t = setTimeout(close, REMASK_MS);
          err.textContent = '30 秒後自動關閉。';
        } catch (x) { if (x.message !== 'cancelled') err.textContent = x.message; }
      });
    }
    if (!allowed) err.textContent = NO_ROLE;
    form.querySelector('[data-x]').addEventListener('click', close);
    form.addEventListener('submit', (e) => e.preventDefault());
    wrap.addEventListener('close', () => clearTimeout(t));
    // focus 關閉, not 顯示: a keystroke meant for the document must not reveal the value
    setTimeout(() => form.querySelector('[data-x]').focus());
  });
  return true;
}

function hide(el) {
  clearTimeout(el._t);
  delete el.dataset.shown;
  el.querySelector('.gdv-v').textContent = DOTS;
  el.querySelector('[data-a=show]').textContent = '顯示';
}

function widget(name, id) {
  const allowed = !server || server.canReveal(id);
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
    if (!allowed) { b.disabled = true; b.title = NO_ROLE; }
    el.append(b);
  }
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.a === 'show' && el.dataset.shown !== undefined) { hide(el); return; }
    try {
      const value = await reveal(name, id, b.dataset.a);
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

/** Replace every {{vault:name}} text occurrence under `root` (a preview of doc `id`) with a masked widget. */
export function mask(root, id = null) {
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
      frag.append(text.slice(last, m.index), widget(m[1], id));
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
