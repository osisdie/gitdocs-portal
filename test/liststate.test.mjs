// List view state (site/liststate.js): panel ⇄ query, legacy URL params, multi-column sort, paging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelFromQuery, queryFromPanel, emptyPanel, panelCount, toggleTag, hasTag, quoteVal, translateLegacy,
  parseSort, sortString, clickSort, sortComparator, parsePer, perParam, paginate, pageList,
  DEFAULT_Q, TIME_PRESETS, timeOfQuery, withTime, withKeywords, withDefaultQuery,
} from '../site/liststate.js';

test('panel ⇄ query round trip keeps unrepresentable tokens in rest', () => {
  const q = 's:open,待確認 cat:plan tag:a+b assignee:me,none,Bob@x.com created>=2026-11-01 created<=2026-11-30 api -s:archived cat:UX';
  const st = panelFromQuery(q);
  assert.deepEqual(st.status, ['待處理', '待確認']);
  assert.deepEqual(st.cat, ['計畫']);
  assert.deepEqual(st.tag, ['a', 'b']);
  assert.equal(st.tagMode, 'all');
  assert.deepEqual(st.assignee, ['me', 'none', 'bob@x.com']);
  assert.equal(st.dateField, 'created');
  assert.equal(st.from, '2026-11-01');
  assert.equal(st.to, '2026-11-30');
  assert.equal(st.rest, 'api -s:archived cat:UX', 'negations, a repeated field and free text are kept verbatim');
  const out = queryFromPanel(st);
  assert.equal(out, 's:open,in-review cat:plan tag:a+b assignee:me,none,bob@x.com created>=2026-11-01 created<=2026-11-30 api -s:archived cat:UX');
  assert.deepEqual(panelFromQuery(out), st, 'stable');
  assert.equal(panelCount(st), 5);
});

test('panel: tags any / all, repeated tag tokens, presets, people by name stay in rest', () => {
  assert.deepEqual(panelFromQuery('tag:a,b').tag, ['a', 'b']);
  assert.equal(panelFromQuery('tag:a,b').tagMode, 'any');
  const two = panelFromQuery('tag:a tag:b');
  assert.deepEqual([two.tag, two.tagMode, two.rest], [['a', 'b'], 'all', '']);
  assert.equal(panelFromQuery('tag:a,b tag:c').rest, 'tag:c');
  assert.equal(panelFromQuery('tag:a+b,c').rest, 'tag:a+b,c');
  assert.equal(panelFromQuery('date>=-7d').datePreset, '7d');
  assert.equal(panelFromQuery('updated>=-30d').dateField, 'updated');
  assert.equal(panelFromQuery('created:this-month').datePreset, 'month');
  assert.equal(panelFromQuery('after:2026-11-01').from, '2026-11-01');
  assert.equal(panelFromQuery('date>=-7d created>=-30d').rest, 'created>=-30d', 'one date field at a time');
  assert.equal(panelFromQuery('date>=-2w').rest, 'date>=-2w');
  assert.equal(panelFromQuery('assignee:alice').rest, 'assignee:alice');
  assert.equal(panelFromQuery('cat:rep').rest, 'cat:rep', 'a partial category is not a checkbox');
  const st = { ...emptyPanel(), tag: ['release notes', 'c++'], tagMode: 'any', type: ['md'], sens: ['機密'], datePreset: '7d', dateField: 'updated' };
  assert.equal(queryFromPanel(st), 'sens:confidential type:md tag:"release notes","c++" updated>=-7d');
  assert.deepEqual(panelFromQuery(queryFromPanel(st)).tag, ['release notes', 'c++']);
  assert.equal(queryFromPanel(emptyPanel()), '');
  assert.equal(quoteVal('a"b'), 'ab');
});

test('tag chips toggle a tag and keep the rest of the query', () => {
  assert.equal(toggleTag('s:open api', 'q4'), 's:open tag:q4 api');
  assert.equal(toggleTag('tag:q4,x api', 'Q4'), 'tag:x api');
  assert.equal(toggleTag('', 'a b'), 'tag:"a b"');
  assert.ok(hasTag('tag:a+b', 'B'));
});

test('legacy list params fold into q= and sort=key:dir', () => {
  const sp = translateLegacy(new URLSearchParams('p=ops&q=foo&c=計畫&s=待處理&sv=機密&ty=md&k=a b&k=c&sort=title&dir=asc&page=3'));
  assert.equal(sp.get('q'), 'foo cat:plan s:open sens:confidential type:md tag:"a b" tag:c');
  assert.equal(sp.get('sort'), 'title:asc');
  assert.equal(sp.get('p'), 'ops');
  assert.ok(!sp.has('dir') && !sp.has('k') && !sp.has('page'));
  assert.equal(translateLegacy(new URLSearchParams('p=ops&q=x&sort=date:asc')), null);
  assert.equal(translateLegacy(new URLSearchParams('c=Custom cat')).get('q'), 'cat:"Custom cat"');
  assert.equal(translateLegacy(new URLSearchParams('sort=id&dir=sideways')).get('sort'), 'id:desc');
});

test('sort spec: parse, header clicks, comparator', () => {
  assert.deepEqual(parseSort('status:asc,date:desc'), [{ key: 'status', dir: 'asc' }, { key: 'date', dir: 'desc' }]);
  assert.deepEqual(parseSort('bogus,title,title:desc,id,date'), [{ key: 'title', dir: 'asc' }, { key: 'id', dir: 'desc' }]);
  assert.deepEqual(parseSort('', 'score'), [{ key: 'score', dir: 'desc' }]);
  const s = parseSort('status:asc,date:desc');
  assert.equal(sortString(clickSort(s, 'status')), 'status:desc,date:desc', 'click on the primary flips it, secondary stays');
  assert.equal(sortString(clickSort(s, 'title')), 'title:asc');
  assert.equal(sortString(clickSort(s, 'title', true)), 'status:asc,title:asc');
  let t = clickSort(parseSort('status:asc'), 'date', true);
  assert.equal(sortString(t), 'status:asc,date:desc');
  t = clickSort(t, 'date', true);
  assert.equal(sortString(t), 'status:asc,date:asc');
  t = clickSort(t, 'date', true);
  assert.equal(sortString(t), 'status:asc', 'third shift+click removes it');
  const rows = [{ s: 'b', n: 1 }, { s: 'a', n: 2 }, { s: 'b', n: 3 }, { s: 'a', n: 1 }];
  rows.sort(sortComparator(parseSort('status:asc,id:desc'), { status: (r) => r.s, id: (r) => r.n, date: () => 0 }));
  assert.deepEqual(rows.map((r) => `${r.s}${r.n}`), ['a2', 'a1', 'b3', 'b1']);
});

test('paging: per-page parsing, clamping, page numbers', () => {
  assert.equal(parsePer('100'), 100);
  assert.equal(parsePer('all'), 0);
  assert.equal(parsePer(undefined, 25), 25);
  assert.equal(parsePer('7', 0), 0, 'an invalid URL value falls back to the preference');
  assert.equal(parsePer(null, 'x'), 50);
  assert.equal(perParam(0), 'all');
  assert.deepEqual(paginate(120, '3', 50), { page: 3, pages: 3, start: 100, end: 120 });
  assert.deepEqual(paginate(120, '9', 50), { page: 3, pages: 3, start: 100, end: 120 });
  assert.deepEqual(paginate(0, 'x', 50), { page: 1, pages: 1, start: 0, end: 0 });
  assert.deepEqual(paginate(120, 2, 0), { page: 1, pages: 1, start: 0, end: 120 });
  assert.deepEqual(pageList(5, 10), [1, '…', 4, 5, 6, '…', 10]);
  assert.deepEqual(pageList(1, 10), [1, 2, '…', 10]);
  assert.deepEqual(pageList(3, 10), [1, 2, 3, 4, '…', 10]);
  assert.deepEqual(pageList(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageList(1, 1), [1]);
});

test('capQuery: search text longer than Q_MAX is cut at a word boundary', async () => {
  const { capQuery, Q_MAX } = await import('../site/liststate.js');
  assert.deepEqual(capQuery('api s:open'), { q: 'api s:open', cut: false });
  const long = Array.from({ length: 2000 }, (_, i) => `-zz${i}`).join(' ');
  const r = capQuery(long);
  assert.equal(r.cut, true);
  assert.ok(r.q.length <= Q_MAX);
  assert.ok(long.startsWith(r.q + ' '), 'cut on a token boundary');
});

test('simple row: time option of a query', () => {
  assert.equal(DEFAULT_Q, 'updated>=-7d');
  assert.equal(timeOfQuery(DEFAULT_Q), '7d');
  assert.equal(timeOfQuery('api updated>=-30d s:open'), '30d');
  assert.equal(timeOfQuery('updated:this-month'), 'month');
  assert.equal(timeOfQuery(''), 'any');
  assert.equal(timeOfQuery('api s:open'), 'any');
  assert.equal(timeOfQuery('date>=-7d'), 'custom', 'another date field');
  assert.equal(timeOfQuery('updated>=2026-11-01'), 'custom', 'a range');
  assert.equal(timeOfQuery('updated>=-7d created>=-30d'), 'custom', 'a second date condition (kept in rest)');
  assert.equal(timeOfQuery('-updated>=-7d'), 'custom', 'a negated date');
  assert.equal(timeOfQuery('date:2026-11'), 'custom');
  for (const [k, tok] of Object.entries(TIME_PRESETS)) assert.equal(timeOfQuery(tok), k);
});

test('simple row: withTime replaces every date condition and keeps the rest', () => {
  assert.equal(withTime('api s:open', '7d'), 's:open updated>=-7d api');
  assert.equal(withTime('updated>=-7d api', '30d'), 'updated>=-30d api');
  assert.equal(withTime('updated>=-7d api', 'month'), 'updated:this-month api');
  assert.equal(withTime('updated>=-7d', 'any'), '');
  assert.equal(withTime('created>=2026-01-01 created<=2026-02-01 x', 'any'), 'x');
  assert.equal(withTime('date>=-7d -updated>=-30d after:2026-01-01 api', '7d'), 'updated>=-7d api', 'dates in rest go too');
  assert.equal(withTime('api', 'bogus'), 'api', 'unknown preset = no date');
});

test('simple row: withKeywords sets the free text and keeps panel tokens', () => {
  assert.equal(withKeywords('updated>=-7d', 'api "rate limit"'), 'updated>=-7d api "rate limit"');
  assert.equal(withKeywords('s:open updated>=-7d old words', ' new '), 's:open updated>=-7d new');
  assert.equal(withKeywords('s:open old', ''), 's:open');
  assert.equal(withKeywords('', 'x'), 'x');
});

test('default query: only when the q param is absent', () => {
  assert.equal(withDefaultQuery(new URLSearchParams('p=a')).toString(), 'p=a&q=updated%3E%3D-7d');
  assert.equal(withDefaultQuery(new URLSearchParams('')).get('q'), DEFAULT_Q);
  assert.equal(withDefaultQuery(new URLSearchParams('q=')), null, 'explicit empty q = any time');
  assert.equal(withDefaultQuery(new URLSearchParams('q')), null);
  assert.equal(withDefaultQuery(new URLSearchParams('q=s:open')), null);
  assert.equal(new URLSearchParams([['p', 'a'], ['q', '']]).toString(), 'p=a&q=', 'the marker survives serialization');
  // legacy params are translated first: their tokens become q, so the default does not apply
  assert.equal(withDefaultQuery(translateLegacy(new URLSearchParams('s=待處理'))), null);
});
