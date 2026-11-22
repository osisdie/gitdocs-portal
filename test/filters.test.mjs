// site/filters.js pure helpers: CSV escaping / formula neutralising / BOM, personal filter limits and migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvCell, toCsv, docsCsv, csvValue, csvFilename, canonParams, isActive, catalogParams, hasFilter,
  upsertPersonal, mergeFilters, fitsPrefs, readableList, LIMITS,
} from '../site/filters.js';
import { setLang } from '../site/i18n.js';
import { addPeople, clearPeople } from '../site/model.js';

test('csvCell: RFC 4180 quoting and doubled quotes', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell('中文，全形逗號'), '中文，全形逗號', 'full-width comma needs no quoting');
});

test('csvCell: spreadsheet formula injection is neutralised with a leading apostrophe', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('\rx'), "\"'\rx\"", 'CR start: prefixed and quoted');
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
  assert.equal(csvCell('2026-11-22'), '2026-11-22', 'dates are untouched');
  assert.equal(csvCell('a=b'), 'a=b', 'only a leading formula character counts');
});

test('toCsv: UTF-8 BOM, CRLF records, trailing CRLF', () => {
  const text = toCsv(['a', 'b'], [['1', '2'], ['x,y', '=z']]);
  assert.equal(text, '﻿a,b\r\n1,2\r\n"x,y",\'=z\r\n');
  assert.deepEqual([...new TextEncoder().encode(text).slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('docsCsv: display labels in the current language, padded ids, people names, dates, keywords', () => {
  clearPeople();
  addPeople({ 'ann@example.com': 'Ann Lee' });
  const doc = {
    id: 12, status: '待處理', sensitivity: '機密', category: '報告', project: 'alpha', subproject: 'sub', title: 'T "1"',
    keywords: ['k1', 'k2'], tags: ['t'], assignee: 'ann@example.com', reviewer: 'bob@example.com', date: '2026-11-01', updated_at: '2026-11-20T10:00:00Z',
  };
  const columns = ['id', 'status', 'sens', 'category', 'project', 'title', 'keywords', 'assignee', 'reviewer', 'date', 'updated'].map((key) => ({ key, label: key }));
  try {
    setLang('en');
    let lines = docsCsv({ rows: [doc], columns }).slice(1).split('\r\n');
    assert.equal(lines[0], columns.map((c) => c.key).join(','));
    assert.equal(lines[1], '0000012,Open,Confidential,Report,alpha/sub,"T ""1""",k1; k2,Ann Lee,bob,2026-11-01,2026-11-20');
    setLang('zh-TW');
    lines = docsCsv({ rows: [doc], columns }).slice(1).split('\r\n');
    assert.match(lines[1], /^0000012,待處理,機密,報告,alpha\/sub,/);
    assert.equal(csvValue({ project: '（索引）' }, 'project'), '（索引）');
    setLang('en');
    assert.equal(csvValue({ project: '（索引）' }, 'project'), '(Index)');
  } finally { setLang('en'); clearPeople(); }
});

test('csvValue: restricted docs never pass unknown fields through; vault fields never appear', () => {
  const d = { id: 1, title: 'secret plan', desc: 'shown in the list', path: 'docs/a/x.md', vault: ['a/token'], restricted: true };
  assert.equal(csvValue(d, 'title'), 'secret plan');
  assert.equal(csvValue(d, 'desc'), 'shown in the list');
  assert.equal(csvValue(d, 'path'), '');
  assert.equal(csvValue(d, 'vault'), '');
  const open = { ...d, restricted: undefined };
  assert.equal(csvValue(open, 'path'), 'docs/a/x.md');
  assert.equal(csvValue(open, 'vault'), '');
  assert.equal(csvValue(open, 'toString'), '', 'inherited properties are not fields');
});

test('csvFilename: docs-<project|all>-<YYYYMMDD>.csv, unsafe characters replaced', () => {
  const now = new Date(2026, 10, 2);
  assert.equal(csvFilename('', now), 'docs-all-20261102.csv');
  assert.equal(csvFilename('alpha/sub', now), 'docs-alpha_sub-20261102.csv');
  assert.equal(csvFilename('（索引）', now), 'docs-（索引）-20261102.csv');
  assert.equal(csvFilename('../x', now), 'docs-x-20261102.csv');
});

test('canonParams / isActive / catalogParams / hasFilter', () => {
  assert.equal(canonParams('s=a&p=x&page=3&q='), 'p=x&s=a');
  assert.equal(canonParams('k=b&k=a&c=1'), 'c=1&k=b&k=a', 'repeated keys keep their order');
  assert.ok(isActive('p=x&s=a', 's=a&p=x&page=2&sort=title&dir=asc'), 'saved without sort matches any sort');
  assert.ok(!isActive('p=x&s=a&sort=id', 'p=x&s=a&sort=title'));
  assert.ok(!isActive('p=x&s=a', 'p=x&s=a&c=r'));
  assert.equal(catalogParams('s:待處理', 'alpha'), new URLSearchParams({ p: 'alpha', q: 's:待處理' }).toString());
  assert.ok(isActive(catalogParams('s:x', ''), 'q=s%3Ax&sort=date'));
  assert.ok(!hasFilter('p=alpha&sort=id&dir=asc&page=2'));
  assert.ok(hasFilter('p=alpha&k=x'));
  assert.ok(!hasFilter(''));
});

test('upsertPersonal: name / params / count limits; same name replaces', () => {
  let r = upsertPersonal([], { name: '  mine ', params: 's=a&page=4' });
  assert.deepEqual(r, { list: [{ name: 'mine', params: 's=a' }], replaced: false });
  r = upsertPersonal(r.list, { name: 'mine', params: 's=b' });
  assert.deepEqual(r, { list: [{ name: 'mine', params: 's=b' }], replaced: true });
  assert.equal(upsertPersonal([], { name: '', params: 's=a' }).error, 'sf.errName');
  assert.equal(upsertPersonal([], { name: 'x'.repeat(LIMITS.name + 1), params: 's=a' }).error, 'sf.errName');
  assert.equal(upsertPersonal([], { name: 'a\u0007b', params: 's=a' }).error, 'sf.errName');
  assert.equal(upsertPersonal([], { name: 'long', params: `q=${'x'.repeat(LIMITS.params)}` }).error, 'sf.errTooLong');
  const full = Array.from({ length: LIMITS.count }, (_, i) => ({ name: `f${i}`, params: 's=a' }));
  assert.equal(upsertPersonal(full, { name: 'one more', params: 's=a' }).error, 'sf.errTooMany');
  assert.equal(upsertPersonal(full, { name: 'f3', params: 's=b' }).replaced, true, 'replacing is fine at the cap');
});

test('readableList keeps legacy entries readable and drops malformed ones', () => {
  const legacy = [{ name: 'x'.repeat(100), params: 'q=a' }, { name: 'ok', params: 'p=b' }, { name: '', params: 'q' }, null, { name: 'n' }, 'str'];
  assert.deepEqual(readableList(legacy).map((f) => f.name.length), [100, 2]);
  assert.deepEqual(readableList('nope'), []);
});

test('mergeFilters: server first, local names added once, invalid dropped, capped and fitted into prefs', () => {
  const server = [{ name: 'a', params: 's=1' }];
  const local = [{ name: 'a', params: 's=local' }, { name: 'b', params: 's=2' }, { name: 'b', params: 's=dup' }, { name: 'x'.repeat(99), params: 's=3' }];
  assert.deepEqual(mergeFilters(server, local), [{ name: 'a', params: 's=1' }, { name: 'b', params: 's=2' }]);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}`, params: 's=a' }));
  assert.equal(mergeFilters([], many).length, LIMITS.count);
  const big = Array.from({ length: 30 }, (_, i) => ({ name: `big${i}`, params: `q=${'y'.repeat(900)}` }));
  const out = mergeFilters([], big, { theme: 'dark' });
  assert.ok(out.length > 0 && out.length < 30);
  assert.ok(fitsPrefs({ theme: 'dark' }, out));
  assert.ok(!fitsPrefs({ theme: 'dark' }, big));
});
