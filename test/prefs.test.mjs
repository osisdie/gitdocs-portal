// site/api.js preferences in server mode: localStorage is shared by every account on a browser, so only UI-only keys
// may flow between it and the server copy (another identity's saved filters or focus projects must never leak in).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const puts = [];
globalThis.fetch = async (url, init = {}) => {
  const res = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === '/api/me') return res({ email: 'B@tenant-b.example', roles: {}, prefs: { lang: 'zh-TW' } });
  if (url === '/api/me/prefs' && init.method === 'PUT') { puts.push(JSON.parse(init.body)); return res({ ok: true }); }
  return new Response('not found', { status: 404 });
};

const { detectMe, getPrefs, setPrefs } = await import('../site/api.js');

test('server mode: local prefs of another account contribute only UI-only keys, and only those are mirrored back', async () => {
  // left behind by account A on this browser
  store.set('gitdocs:prefs', JSON.stringify({
    theme: 'dark', listPer: 25, focusProjects: ['tenant-a'], savedFilters: [{ name: 'A only', params: 'p=tenant-a&q=a:alice' }],
  }));
  const me = await detectMe();
  assert.equal(me.email, 'b@tenant-b.example');

  const p = getPrefs();
  assert.equal(p.theme, 'dark');
  assert.equal(p.listPer, 25);
  assert.equal(p.lang, 'zh-TW', 'the server copy wins');
  assert.equal('savedFilters' in p, false);
  assert.equal('focusProjects' in p, false);

  await setPrefs({ savedFilters: [{ name: 'B filter', params: 'p=tenant-b' }] });
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].savedFilters, [{ name: 'B filter', params: 'p=tenant-b' }]);
  assert.equal('focusProjects' in puts[0], false, 'nothing of A reaches B’s server prefs');
  const local = JSON.parse(store.get('gitdocs:prefs'));
  assert.deepEqual(Object.keys(local).sort(), ['lang', 'listPer', 'theme'], 'the mirror holds UI-only keys');
});
