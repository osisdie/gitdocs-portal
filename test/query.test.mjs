// Query language (site/query.js): people fields, comma OR, tag all-mode, created / updated dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, matchDoc, tokenize, valueGroups, resolveDate, docCreated, docUpdated, usesMe, usesHistory } from '../site/query.js';

const TODAY = new Date(2026, 10, 22); // 2026-11-22 local
const doc = (over = {}) => ({
  id: 7, title: 'Ops review', project: 'ops', subproject: '', category: '報告', status: '待處理', sensitivity: '內部',
  date: '2026-10-01', tags: ['q4', 'c++'], keywords: ['API', 'Cost'], path: 'docs/x.md', type: 'md', desc: '',
  reporter: 'bob@example.com', assignee: 'Alice@Example.com', reviewer: '', ...over,
});
const names = { 'alice@example.com': 'Alice Chen', 'bob@example.com': '王小明' };
const ctx = { me: 'alice@example.com', name: (e) => names[String(e).toLowerCase()] || '' };
const hit = (q, d = doc(), c = ctx) => Boolean(matchDoc(d, parseQuery(q, TODAY), '', c));

test('people fields: email, @domain, name substring, me, none, aliases', () => {
  assert.ok(hit('assignee:alice@example.com'));
  assert.ok(hit('a:ALICE@example.com'));
  assert.ok(hit('asg:@example.com'));
  assert.ok(hit('assignee:chen'));
  assert.ok(hit('assignee:"alice chen"'));
  assert.ok(hit('rep:小明'));
  assert.ok(hit('reporter:bob'), 'falls back to the email local part');
  assert.ok(hit('assignee:me'));
  assert.ok(!hit('reporter:me'));
  assert.ok(hit('rev:none'));
  assert.ok(!hit('assignee:none'));
  assert.ok(!hit('reviewer:me'), 'an unset field is not me');
  assert.ok(!hit('assignee:me', doc(), {}), 'no current user: me matches nothing');
  assert.ok(hit('-assignee:me', doc(), {}));
});

test('comma = any of within one field; repeating a field = AND; English aliases per value', () => {
  assert.ok(hit('s:待處理,待確認'));
  assert.ok(hit('s:in-review,open'));
  assert.ok(hit('status:Open,Confirmed'));
  assert.ok(!hit('s:confirmed,archived'));
  assert.ok(hit('cat:plan,report'));
  assert.ok(hit('sens:public,internal'));
  assert.ok(!hit('sens:confidential,secret'));
  assert.ok(hit('assignee:me,none'));
  assert.ok(hit('reviewer:me,none'));
  assert.ok(!hit('s:open s:in-review'), 'repeated field tokens AND');
  assert.ok(!hit('-s:archived,open'), 'negation covers every alternative');
  assert.ok(hit('type:html,md'));
  assert.ok(hit('id:3,7'));
  assert.ok(hit('p:x,ops'));
});

test('enum values: exact when the value names one, partial otherwise', () => {
  assert.ok(hit('cat:report'));
  assert.ok(hit('cat:rep'), 'partial');
  assert.ok(!hit('cat:plan'));
  assert.ok(hit('cat:UX', doc({ category: '設計／UX' })));
});

test('tags: any (comma), all (plus), DNF, literal plus and quoting', () => {
  assert.ok(hit('tag:q4,missing'));
  assert.ok(hit('tag:q4+api'), 'keywords count as tags, case-insensitive');
  assert.ok(!hit('tag:q4+missing'));
  assert.ok(hit('tag:missing+x,cost'));
  assert.ok(hit('tag:c++'), 'empty + parts keep the value literal');
  assert.ok(hit('tag:"c++"'));
  assert.deepEqual(valueGroups('a+b,"c,d",e', 'tag'), [['a', 'b'], ['c,d'], ['e']]);
  assert.deepEqual(valueGroups('a+b', 'status'), [['a+b']], '+ splits only tags');
  assert.deepEqual(tokenize('a:"Alice Chen",bob x').map((t) => t.raw), ['a:"Alice Chen",bob', 'x']);
});

test('created / updated dates with operators and relative forms', () => {
  const d = doc({ history: [{ date: '2026-11-20' }, { date: '2026-11-02' }, { date: '2026-09-15' }], updated_at: '2026-11-21T08:00:00Z' });
  assert.equal(docCreated(d), '2026-09-15');
  assert.equal(docUpdated(d), '2026-11-21');
  assert.equal(docUpdated(doc({ history: [{ date: '2026-11-20' }], updated_at: '2026-11-01T00:00:00Z' })), '2026-11-20');
  assert.equal(docCreated(doc()), '2026-10-01', 'no history: the doc date');
  assert.equal(docCreated(doc({ created: '2026-01-02' })), '2026-01-02');
  assert.ok(hit('created:2026-09', d));
  assert.ok(hit('created<=2026-09-30', d));
  assert.ok(!hit('created>=-7d', d));
  assert.ok(hit('updated>=-7d', d));
  assert.ok(hit('updated:this-month', d));
  assert.ok(hit('updated>=2026-11-21 updated<=2026-11-21', d));
  assert.ok(hit('date:2026-10 after:2026-09-30 before:2026-10-01', d));
  assert.equal(resolveDate('-7d', TODAY), '2026-11-15');
  assert.equal(resolveDate('-1m', TODAY), '2026-10-22');
  assert.equal(resolveDate('today', TODAY), '2026-11-22');
  assert.equal(resolveDate('this-month', TODAY), '2026-11');
  assert.equal(resolveDate('this-year', TODAY), '2026');
  assert.equal(resolveDate('2026-01-01', TODAY), '2026-01-01');
});

test('free text is unchanged; unknown field-looking tokens stay terms; helpers', () => {
  const q = parseQuery('api "release notes" -draft foo:bar', TODAY);
  assert.deepEqual(q.terms, ['api', 'release notes', 'foo:bar']);
  assert.deepEqual(q.not, ['draft']);
  assert.equal(q.fields.length, 0);
  assert.ok(usesMe(parseQuery('rev:none,ME')));
  assert.ok(!usesMe(parseQuery('assignee:meg')));
  assert.ok(usesHistory(parseQuery('updated>=-7d')));
  assert.ok(!usesHistory(parseQuery('date>=-7d')));
});
