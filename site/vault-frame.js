/* gitdocs vault shim — inlined by the build into HTML docs that contain {{vault:…}} or {{vault-blocked}}.
   Docs are served sandboxed (opaque origin, see _headers), so this shim never sees keys or plaintext: it only masks
   the placeholders and asks the portal (parent frame) to show the value in the portal's own dialog.
   It cannot import the portal's i18n module and cannot know the portal's language (the doc is a separate, sandboxed
   page), so it carries its two locales inline and follows the document's own <html lang>: zh* → 繁體中文, else English.
   {{vault-blocked}} (a reference an external source may not use, rewritten by the build) becomes a disabled mask:
   no button, nothing to ask the portal for. */
(function () {
  var RE = /\{\{\s*vault:([A-Za-z0-9_.\/-]+)\s*\}\}|\{\{\s*vault-blocked\s*\}\}/g;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var framed = window.parent !== window;
  var MSG = {
    en: { show: 'Show', showInPortal: 'Show in portal', aria: 'Show vault: ', field: 'vault: ',
      alone: 'Vault fields are shown on the document page of the portal: this tab is isolated and has no access to the keys.',
      blocked: 'This vault reference was disabled: an external source may only use its own vault names' },
    zh: { show: '\u986f\u793a', showInPortal: '\u5728\u5165\u53e3\u986f\u793a', aria: '\u986f\u793a vault\uff1a', field: 'vault\uff1a',
      blocked: '\u9019\u500b vault \u53c3\u7167\u5df2\u505c\u7528\uff1a\u5916\u90e8\u4f86\u6e90\u53ea\u80fd\u4f7f\u7528\u81ea\u5df1\u540d\u4e0b\u7684 vault \u540d\u7a31',
      alone: 'vault \u6b04\u4f4d\u8981\u5728\u5165\u53e3\u7db2\u7ad9\u7684\u6587\u4ef6\u9801\u88e1\u986f\u793a\uff1a\u9019\u500b\u5206\u9801\u662f\u9694\u96e2\u7684\uff0c\u62ff\u4e0d\u5230\u91d1\u9470\u3002' },
  };
  var T = MSG[/^zh/i.test(document.documentElement.lang || '') ? 'zh' : 'en'];
  function css() {
    var s = document.createElement('style');
    s.textContent = '.gdv{display:inline-flex;align-items:center;gap:.3em;padding:0 .3em;border:1px dashed currentColor;border-radius:4px;white-space:nowrap;opacity:.9}'
      + '.gdv-v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em}'
      + '.gdv button{font:600 11px/1.4 system-ui,sans-serif;padding:0 .45em;border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.75}'
      + '.gdv button:hover,.gdv button:focus-visible{opacity:1}'
      + '.gdv.gdv-blocked{border-style:dotted;opacity:.6;cursor:not-allowed}';
    (document.head || document.documentElement).appendChild(s);
  }
  function blocked() {
    var el = document.createElement('span');
    el.className = 'gdv gdv-blocked';
    el.title = T.blocked;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', T.blocked);
    var v = document.createElement('span');
    v.className = 'gdv-v';
    v.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    el.appendChild(v);
    return el;
  }
  function widget(name) {
    var el = document.createElement('span');
    el.className = 'gdv';
    el.title = T.field + name;
    var v = document.createElement('span');
    v.className = 'gdv-v';
    v.textContent = '••••••••';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = framed ? T.show : T.showInPortal;
    b.setAttribute('aria-label', T.aria + name);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (framed) window.parent.postMessage({ type: 'gitdocs:vault', name: name }, '*');
      else alert(T.alone);
    });
    el.appendChild(v);
    el.appendChild(b);
    return el;
  }
  function run() {
    var root = document.body;
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n, p, skip;
    while ((n = walker.nextNode())) {
      if (n.nodeValue.indexOf('{{') < 0) continue;
      for (skip = false, p = n.parentNode; p && p !== root; p = p.parentNode) if (SKIP[p.nodeName]) { skip = true; break; }
      if (!skip) nodes.push(n);
    }
    var count = 0;
    nodes.forEach(function (node) {
      var text = node.nodeValue, last = 0, m, frag = document.createDocumentFragment();
      RE.lastIndex = 0;
      while ((m = RE.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        frag.appendChild(m[1] ? widget(m[1]) : blocked());
        last = m.index + m[0].length;
        count++;
      }
      if (!last) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    if (count) css();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
