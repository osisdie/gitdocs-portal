// Vault UI for the portal shell (never loaded by documents).
//  • mask(root)          — replaces {{vault:<name>}} text in portal-rendered previews (Markdown / text / JSON) with a
//                          masked field whose Show / Copy buttons decrypt in place.
//  • revealDialog(name)  — portal-owned dialog used when a sandboxed HTML document asks (postMessage) to show a field;
//                          it opens masked and decrypts only on the user's click; the plaintext is never handed to
//                          the document.
// Static mode: the key is a non-extractable CryptoKey held in memory only (survives in-app navigation, not reloads).
// Server mode (useServer): no passphrase and no key in the browser — POST /api/vault/reveal checks the role, audits
// the access and returns one value; viewers get the mask with disabled buttons.
import { VAULT_RE, deriveKey, unseal, verifyKey } from './vault-core.js';
import { api } from './api.js';
import { t } from './i18n.js';

const REMASK_MS = 30000;
const DOTS = '••••••••';
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE']);
// {{vault-blocked}}: the build's replacement for a reference an external source may not use (outside <source>/).
const MASK_RE = new RegExp(`${VAULT_RE.source}|\\{\\{\\s*vault-blocked\\s*\\}\\}`, 'g');
let vaultP = null;
let key = null;
let keyP = null;
let server = null; // { canReveal(docId) } in server mode
/** Why the reveal buttons are disabled for viewers (same wording as the server's 403). */
export const noRole = () => t('srv.needEditor');

/** Switch to the server vault. `canReveal(docId)` decides whether the buttons are enabled for that document. */
export function useServer(opts) { server = opts; }
export const isServerVault = () => Boolean(server);

const emit = () => document.dispatchEvent(new CustomEvent('gitdocs:vault', { detail: { unlocked: Boolean(key) } }));
const loadVault = () => (vaultP ||= fetch('vault.json', { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(t('vault.notDeployed'));
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
.gdv.gdv-blocked{border-style:dotted;opacity:.6}
.gdv-dlg{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:16px}
.gdv-dlg form{background:var(--surface,#fff);color:var(--fg,#1b1f24);border:1px solid var(--line,#d0d7de);border-radius:10px;padding:18px 20px;width:min(420px,100%);box-shadow:0 12px 40px rgba(0,0,0,.3)}
.gdv-dlg h2{margin:0 0 4px;font-size:16px}.gdv-dlg p{margin:0 0 12px;color:var(--muted,#57606a);font-size:13px}
.gdv-dlg input,.gdv-dlg output{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#8c959f);border-radius:6px;font:inherit;background:var(--bg,#fff);color:inherit}
.gdv-dlg output{font-family:var(--mono,ui-monospace,monospace);white-space:pre-wrap;word-break:break-all;min-height:2.4em}
.gdv-dlg .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.gdv-dlg button{padding:6px 14px;border-radius:6px;border:1px solid var(--line,#8c959f);background:transparent;color:inherit;font:inherit;cursor:pointer}
.gdv-dlg button.pri{background:var(--accent,#245c73);border-color:var(--accent,#245c73);color:var(--accent-fg,#fff)}
.gdv-dlg .err{color:#cf222e;min-height:1.2em;margin:8px 0 0;font-size:13px}
.gdv-dlg .note{color:var(--muted,#57606a);margin:6px 0 0;font-size:13px}
.gdv-dlg .note:empty{display:none}`;
  document.head.appendChild(s);
}

/** Generic modal; `build(form, close)` fills it. Escape / Cancel closes. */
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
      form.innerHTML = `<h2></h2><p></p>
        <input type="password" autocomplete="off" spellcheck="false" required>
        <div class="err" aria-live="polite"></div>
        <div class="row"><button type="button" data-x></button><button type="submit" class="pri"></button></div>`;
      form.querySelector('h2').textContent = t('vault.unlockTitle');
      form.querySelector('p').textContent = t('vault.unlockHelp');
      form.querySelector('input').setAttribute('aria-label', t('vault.passphrase'));
      form.querySelector('[data-x]').textContent = t('btn.cancel');
      form.querySelector('.pri').textContent = t('vault.unlock');
      const input = form.querySelector('input'), err = form.querySelector('.err');
      form.querySelector('[data-x]').addEventListener('click', close);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = t('vault.verifying');
        try {
          const k = await deriveKey(input.value, vault.kdf, false);
          if (!(await verifyKey(k, vault))) { err.textContent = t('vault.wrong'); input.select(); return; }
          key = k; emit(); resolve(k); close();
        } catch (x) { err.textContent = t('vault.unlockFailed', { msg: x.message }); }
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
    if (!server.canReveal(id)) throw new Error(noRole());
    const r = await api('POST', '/api/vault/reveal', { id: Number(id), name, action });
    if (typeof r?.value !== 'string') throw new Error(t('vault.noValue'));
    return r.value;
  }
  const box = (await loadVault()).secrets?.[name];
  if (!box) throw new Error(t('vault.missing', { name }));
  return unseal(await getKey(), name, box);
}

/**
 * Masked dialog for one secret: it opens masked and reveals only on the user's click on Show / Copy (server mode:
 * each click is audited), auto-closes 30 s after a reveal, and focuses Close so no stray keystroke reveals. The value
 * is dropped from the DOM when the dialog closes. While one is open further requests are ignored.
 * `revealFn(action)` → value; `allowed` false disables both buttons with `denied` as the reason.
 */
function secretDialog({ name, intro, revealFn, allowed = true, denied = '' }) {
  if (document.querySelector('.gdv-dlg[data-reveal]')) return false;
  modal((form, close, wrap) => {
    wrap.dataset.reveal = '';
    form.innerHTML = `<h2></h2><p></p><output></output><div class="note" aria-live="polite"></div><div class="err" aria-live="polite"></div>
      <div class="row"><button type="button" data-a="show"></button><button type="button" data-a="copy"></button><button type="button" class="pri" data-x></button></div>`;
    form.querySelector('h2').textContent = t('vault.fieldTitle', { name });
    form.querySelector('p').textContent = intro;
    form.querySelector('[data-a=show]').textContent = t('vault.show');
    form.querySelector('[data-a=copy]').textContent = t('vault.copy');
    form.querySelector('[data-x]').textContent = t('btn.close');
    const out = form.querySelector('output'), err = form.querySelector('.err'), note = form.querySelector('.note');
    out.textContent = DOTS;
    let timer = null;
    for (const b of form.querySelectorAll('[data-a]')) {
      if (!allowed) { b.disabled = true; b.title = denied; }
      b.addEventListener('click', async () => {
        err.textContent = ''; note.textContent = '';
        try {
          const value = await revealFn(b.dataset.a);
          if (!wrap.isConnected) return;
          if (b.dataset.a === 'copy') { await navigator.clipboard.writeText(value); b.textContent = t('vault.copied'); return; }
          out.textContent = value;
          clearTimeout(timer);
          timer = setTimeout(close, REMASK_MS);
          note.textContent = t('vault.autoClose', { n: REMASK_MS / 1000 }); // informational: muted, not an error
        } catch (x) { if (x.message !== 'cancelled') err.textContent = x.message; }
      });
    }
    if (!allowed) err.textContent = denied;
    form.querySelector('[data-x]').addEventListener('click', close);
    form.addEventListener('submit', (e) => e.preventDefault());
    wrap.addEventListener('close', () => { clearTimeout(timer); out.textContent = ''; });
    // focus Close, not Show: a keystroke meant for the document must not reveal the value
    setTimeout(() => form.querySelector('[data-x]').focus());
  });
  return true;
}

/** Dialog for a field a sandboxed HTML document asked to show (postMessage); revealed as that document's reference. */
export function revealDialog(name, from = '', id = null) {
  return secretDialog({
    name,
    intro: from ? t('vault.askedBy', { doc: from }) : t('vault.clickToReveal'),
    revealFn: (action) => reveal(name, id, action),
    allowed: !server || server.canReveal(id),
    denied: noRole(),
  });
}

/** Dialog for a secret on the project vault page (server mode, page form of POST /api/vault/reveal: no doc id). */
export function revealSecretDialog(name, { allowed = true, denied = '' } = {}) {
  return secretDialog({
    name,
    intro: t('vault.clickToReveal'),
    allowed,
    denied,
    revealFn: async (action) => {
      let r;
      try { r = await api('POST', '/api/vault/reveal', { name, action }); } catch (x) { throw x.status === 503 ? new Error(t('pv.noKey')) : x; }
      if (typeof r?.value !== 'string') throw new Error(t('vault.noValue'));
      return r.value;
    },
  });
}

function hide(el) {
  clearTimeout(el._t);
  delete el.dataset.shown;
  el.querySelector('.gdv-v').textContent = DOTS;
  el.querySelector('[data-a=show]').textContent = t('vault.show');
}

function widget(name, id) {
  const allowed = !server || server.canReveal(id);
  const el = document.createElement('span');
  el.className = 'gdv';
  el.dataset.vault = name;
  el.title = t('vault.fieldTitle', { name });
  const v = document.createElement('span');
  v.className = 'gdv-v';
  v.textContent = DOTS;
  el.append(v);
  for (const a of ['show', 'copy']) {
    const label = t(`vault.${a}`);
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.a = a; b.textContent = label; b.setAttribute('aria-label', t('vault.btnAria', { action: label, name }));
    if (!allowed) { b.disabled = true; b.title = noRole(); }
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
        b.textContent = t('vault.copied'); setTimeout(() => { b.textContent = t('vault.copy'); }, 1500);
      } else {
        el.dataset.shown = '';
        v.textContent = value;
        b.textContent = t('vault.hide');
        el._t = setTimeout(() => hide(el), REMASK_MS);
      }
    } catch (x) {
      if (x.message !== 'cancelled') { b.textContent = t('vault.failed'); b.title = x.message; setTimeout(() => { b.textContent = t(b.dataset.a === 'copy' ? 'vault.copy' : 'vault.show'); }, 2500); }
    }
  });
  return el;
}

/** Disabled mask for {{vault-blocked}}: there is no secret behind it, nothing can be revealed. */
function blockedWidget() {
  const el = document.createElement('span');
  el.className = 'gdv gdv-blocked';
  el.title = t('vault.blockedHint');
  const v = document.createElement('span');
  v.className = 'gdv-v';
  v.textContent = DOTS;
  const b = document.createElement('button');
  b.type = 'button'; b.disabled = true; b.textContent = t('vault.blocked'); b.title = t('vault.blockedHint');
  el.append(v, b);
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
    for (const m of text.matchAll(MASK_RE)) {
      frag.append(text.slice(last, m.index), m[1] ? widget(m[1], id) : blockedWidget());
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
