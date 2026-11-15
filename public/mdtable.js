/* Markdown (GFM) táblázatok igazítása: az oszlopokat szóközökkel kitölti, hogy egymás alá kerüljenek. */
(function (root) {
  'use strict';

  // Megjelenítési szélesség: kombináló jelek 0, kelet-ázsiai széles karakterek és emojik 2
  function charWidth(cp) {
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
    if (/\p{Mn}|\p{Me}/u.test(String.fromCodePoint(cp))) return 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x2600 && cp <= 0x27bf && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp))) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) return 2;
    return 1;
  }
  function strWidth(s) {
    let w = 0;
    for (const ch of s) w += charWidth(ch.codePointAt(0));
    return w;
  }

  // Sor cellákra bontása: a \| escape-elt pipe nem határoló
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  const DELIM_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

  function alignOf(cell) {
    const l = cell.startsWith(':');
    const r = cell.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : 'none';
  }

  function pad(text, width, align) {
    const gap = width - strWidth(text);
    if (gap <= 0) return text;
    if (align === 'right') return ' '.repeat(gap) + text;
    if (align === 'center') {
      const left = Math.floor(gap / 2);
      return ' '.repeat(left) + text + ' '.repeat(gap - left);
    }
    return text + ' '.repeat(gap);
  }

  function delimCell(width, align) {
    const w = width + 2; // a cellák körüli szóközök helye is
    if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
    if (align === 'left') return ':' + '-'.repeat(w - 1);
    if (align === 'right') return '-'.repeat(w - 1) + ':';
    return '-'.repeat(w);
  }

  function formatTable(lines) {
    const indent = lines[0].match(/^ */)[0];
    const header = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map(alignOf);
    const n = header.length;
    while (aligns.length < n) aligns.push('none');
    aligns.length = n;
    const rows = lines.slice(2).map(splitRow);
    // Hiányzó cellák üresen kitöltve; a fölösleges cellák (a renderelő eldobja) megmaradnak a sor végén
    const body = rows.map((r) => {
      const cells = r.slice(0, n);
      while (cells.length < n) cells.push('');
      return { cells, extra: r.slice(n) };
    });
    const widths = header.map((h, i) => Math.max(3, strWidth(h), ...body.map((r) => strWidth(r.cells[i]))));
    const line = (cells, extra = []) =>
      indent + '| ' + cells.map((c, i) => pad(c, widths[i], aligns[i])).join(' | ') + ' |' +
      (extra.length ? ' ' + extra.join(' | ') + ' |' : '');
    return [
      line(header),
      indent + '|' + widths.map((w, i) => delimCell(w, aligns[i])).join('|') + '|',
      ...body.map((r) => line(r.cells, r.extra)),
    ];
  }

  // A teljes dokumentum összes táblázatának igazítása (kódblokkok kihagyva)
  function formatTables(md) {
    const eol = /\r\n/.test(md) ? '\r\n' : '\n';
    const lines = md.split(/\r?\n/);
    const out = [];
    let fence = null;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const f = l.match(FENCE_RE);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.replace(FENCE_RE, '').trim()) fence = null;
        out.push(l);
        continue;
      }
      if (f) { fence = f[1]; out.push(l); continue; }
      const next = lines[i + 1];
      if (
        l.includes('|') && /^ {0,3}\S/.test(l) && next !== undefined && DELIM_RE.test(next) && next.includes('-') &&
        (next.includes('|') || splitRow(l).length === 1) &&
        splitRow(l).length === splitRow(next).length
      ) {
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes('|') && !FENCE_RE.test(lines[j])) j++;
        out.push(...formatTable(lines.slice(i, j)));
        count++;
        i = j - 1;
        continue;
      }
      out.push(l);
    }
    return { text: out.join(eol), count };
  }

  const api = { formatTables, strWidth };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MdTable = api;
})(typeof window !== 'undefined' ? window : globalThis);
