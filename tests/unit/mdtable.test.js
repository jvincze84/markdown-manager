// Táblázatrendező (public/mdtable.js) egységtesztjei
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTables, strWidth } = require('../../public/mdtable.js');

test('igazítja az oszlopokat és követi a :--- / ---: / :---: igazítást', () => {
  const { text, count } = formatTables('|Név|Kor|Város|\n|:-|-:|:-:|\n|Kovács Árpád|42|Budapest|\n');
  assert.equal(count, 1);
  assert.equal(text, [
    '| Név          | Kor |  Város   |',
    '|:-------------|----:|:--------:|',
    '| Kovács Árpád |  42 | Budapest |',
    '',
  ].join('\n'));
});

test('idempotens', () => {
  const once = formatTables('a|b\n--|--\nhosszabb szöveg|x\n').text;
  assert.equal(formatTables(once).text, once);
});

test('kódblokkban lévő táblázatot nem érint', () => {
  const md = '```\n|x|y|\n|-|-|\n|1|2|\n```\n';
  assert.deepEqual(formatTables(md), { text: md, count: 0 });
});

test('escape-elt pipe nem oszlophatár, hiányzó cella kitöltődik', () => {
  const { text } = formatTables('|a|b|\n|-|-|\n|x \\| y|\n');
  assert.equal(text.split('\n')[2], '| x \\| y |     |');
});

test('széles karakterek (CJK, emoji) dupla szélességűek', () => {
  assert.equal(strWidth('李'), 2);
  assert.equal(strWidth('🚀'), 2);
  assert.equal(strWidth('é'), 1);
});

test('CRLF sorvégek megmaradnak', () => {
  assert.match(formatTables('|a|b|\r\n|-|-|\r\n|1|2|\r\n').text, /\r\n/);
});
