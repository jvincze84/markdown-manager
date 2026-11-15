/*
 * Prism bővítések – közös a szerver (renderelt nézet) és a böngésző (editor előnézet) között,
 * így a kód mindkét helyen ugyanúgy színeződik.
 *  - gyakori nyelv-aliasok (yml, py, ts, tf, dockerfile, …)
 *  - bash: az ismeretlen parancsok (pl. kubectl, helm, saját scriptek) is „function” színt kapnak,
 *    ha parancs pozícióban állnak (sor elején, |, &&, ||, ;, $( után, sudo/xargs/then/do után).
 *    A Prism csak egy fix parancslistát ismer; ezt a token-folyamon utólag egészítjük ki.
 */
'use strict';

// Ezek után ismét parancs következik
const CMD_PREFIX = new Set(['sudo', 'xargs', 'nohup', 'exec', 'time', 'watch', 'env', 'command', 'nice', 'timeout', 'doas']);
const CMD_KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time']);
const CMD_OPERATORS = new Set(['|', '||', '&&', '|&', '&']);
const CMD_PUNCT = new Set([';', '(', '$(', '{', '`', ';;']);
const WORD_RE = /^[A-Za-z_.~/][\w.~/+:@%-]*$/;

const textOf = (t) => (typeof t === 'string' ? t : Array.isArray(t) ? t.map(textOf).join('') : textOf(t.content));

function markCommands(tokens, Prism) {
  let cmdPos = true; // parancs pozícióban vagyunk-e
  let skipValue = false; // FOO=bar cmd → a "bar" érték, utána jöhet a parancs
  let continuation = false; // az előző token egy sorvégi "\" volt
  const out = [];
  for (const t of tokens) {
    if (typeof t !== 'string') {
      const content = textOf(t);
      continuation = false;
      // $( … ) és ` … ` belseje: önálló parancssor
      if (t.type === 'variable' && Array.isArray(t.content) && /^(\$\(|`)/.test(content)) {
        t.content = markCommands(t.content, Prism);
        skipValue = false; cmdPos = false; out.push(t); continue;
      }
      if (skipValue && /^(string|variable|environment|number)$/.test(t.type)) { skipValue = false; out.push(t); continue; }
      if (t.type === 'operator') {
        if (content === '=') { out.push(t); continue; } // FOO=… : az érték következik
        cmdPos = CMD_OPERATORS.has(content);
      } else if (t.type === 'punctuation') {
        if (content === '\\') continuation = true;
        else if (CMD_PUNCT.has(content)) cmdPos = true;
      } else if (t.type === 'variable' && (content === '$(' || content === '`')) {
        cmdPos = true;
      } else if (t.type === 'keyword') {
        cmdPos = CMD_KEYWORDS.has(content);
      } else if (t.type === 'function' || t.type === 'builtin') {
        // A Prism a listáján lévő szavakat argumentumként is parancsnak színezné (pl. "ip", "test")
        if (!cmdPos) { skipValue = false; out.push(content); continue; }
        cmdPos = CMD_PREFIX.has(content);
      } else if (t.type === 'assign-left') {
        skipValue = true; out.push(t); continue;
      } else if (t.type === 'comment' || t.type === 'shebang') {
        /* a sorvég dönti el */
      } else {
        cmdPos = false;
      }
      skipValue = false;
      out.push(t);
      continue;
    }
    // Sima szöveg: sorvég, sorfolytatás (\ + újsor), szóköz, szó
    const re = /(\\\r?\n)|(\r?\n)|([ \t]+)|([^\s]+)/g;
    let m;
    let buf = '';
    let first = true;
    while ((m = re.exec(t))) {
      const cont = continuation && first;
      first = false;
      continuation = false;
      if (m[1]) { buf += m[1]; continue; } // folytatósor: a parancs pozíció nem változik
      if (m[2]) { buf += m[2]; if (!cont) { cmdPos = true; skipValue = false; } continue; }
      if (m[3]) { buf += m[3]; continue; }
      const word = m[4];
      if (skipValue) { skipValue = false; buf += word; continue; }
      if (cmdPos && WORD_RE.test(word)) {
        if (buf) out.push(buf);
        buf = '';
        out.push(new Prism.Token('function', word, ['command'], word));
        cmdPos = CMD_PREFIX.has(word);
        continue;
      }
      cmdPos = false;
      buf += word;
    }
    if (buf) out.push(buf);
  }
  // egymás melletti sima szövegek összevonása
  return out.reduce((acc, x) => {
    if (typeof x === 'string' && typeof acc[acc.length - 1] === 'string') acc[acc.length - 1] += x;
    else acc.push(x);
    return acc;
  }, []);
}

module.exports = function extendPrism(Prism) {
  if (Prism.__mmExtended) return Prism;
  Prism.__mmExtended = true;
  const L = Prism.languages;
  const alias = {
    shell: 'bash', sh: 'bash', zsh: 'bash', console: 'shell-session', env: 'bash',
    yml: 'yaml', js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
    dockerfile: 'docker', terraform: 'hcl', tf: 'hcl', ps1: 'powershell', cs: 'csharp', kt: 'kotlin',
    conf: 'ini', cfg: 'ini', html: 'markup', xml: 'markup', svg: 'markup', md: 'markdown',
  };
  for (const [a, target] of Object.entries(alias)) if (!L[a] && L[target]) L[a] = L[target];
  // Kapcsolók: kötőjeles nevek (--dry-run) és ; | & ) előtt is
  if (L.bash && L.bash.parameter) {
    L.bash.parameter.pattern = /(^|\s)-{1,2}(?:\w+:[+-]?)?\w[\w-]*(?:\.\w+)*(?=[=\s;|&)]|$)/;
  }
  Prism.hooks.add('after-tokenize', (env) => {
    if (L.bash && env.grammar === L.bash) env.tokens = markCommands(env.tokens, Prism);
  });
  return Prism;
};
