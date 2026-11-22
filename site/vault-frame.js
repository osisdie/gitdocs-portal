/* gitdocs vault shim — inlined by the build into HTML docs that contain {{vault:…}}.
   Docs are served sandboxed (opaque origin, see _headers), so this shim never sees keys or plaintext: it only masks
   the placeholders and asks the portal (parent frame) to show the value in the portal's own dialog. */
(function () {
  var RE = /\{\{\s*vault:([A-Za-z0-9_.\/-]+)\s*\}\}/g;
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var framed = window.parent !== window;
  function css() {
    var s = document.createElement('style');
    s.textContent = '.gdv{display:inline-flex;align-items:center;gap:.3em;padding:0 .3em;border:1px dashed currentColor;border-radius:4px;white-space:nowrap;opacity:.9}'
      + '.gdv-v{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em}'
      + '.gdv button{font:600 11px/1.4 system-ui,sans-serif;padding:0 .45em;border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit;cursor:pointer;opacity:.75}'
      + '.gdv button:hover,.gdv button:focus-visible{opacity:1}';
    (document.head || document.documentElement).appendChild(s);
  }
  function widget(name) {
    var el = document.createElement('span');
    el.className = 'gdv';
    el.title = 'vault：' + name;
    var v = document.createElement('span');
    v.className = 'gdv-v';
    v.textContent = '••••••••';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = framed ? '顯示' : '在入口顯示';
    b.setAttribute('aria-label', '顯示 vault：' + name);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (framed) window.parent.postMessage({ type: 'gitdocs:vault', name: name }, '*');
      else alert('vault 欄位要在入口網站的文件頁裡顯示：這個分頁是隔離的，拿不到金鑰。');
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
        frag.appendChild(widget(m[1]));
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
