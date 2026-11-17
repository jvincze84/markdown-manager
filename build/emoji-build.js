// Kompakt emoji adat a szerkesztő emoji-választójához (a Docker build során fut).
// Kimenet: [[emoji, csoport, angol név, keresési szöveg (név, kulcsszavak, GitHub shortcode-ok)], ...]
const fs = require('fs');
const path = require('path');
const en = require('emojibase-data/en/compact.json');
const gh = require('emojibase-data/en/shortcodes/github.json');

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const out = en
  .filter((e) => e.group !== undefined && e.group !== 2) // 2 = bőrszín/hajszín komponensek
  .sort((a, b) => a.order - b.order)
  .map((e) => {
    const codes = [].concat(gh[e.hexcode] || []);
    const words = new Set([e.label, ...(e.tags || []), ...codes].filter(Boolean).map(norm));
    return [e.unicode, e.group, e.label, [...words].join(' ')];
  });
const target = process.argv[2] || path.join(__dirname, '..', 'public-vendor', 'emoji.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));
console.log(`emoji.json: ${out.length} emoji, ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
