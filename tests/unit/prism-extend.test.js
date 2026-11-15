// Kódszínezés bővítései (lib/prism-extend.js): bash parancsfelismerés, kapcsolók, aliasok
const test = require('node:test');
const assert = require('node:assert/strict');
const Prism = require('prismjs');
require('prismjs/components/')(['bash', 'yaml', 'python', 'shell-session']);
require('../../lib/prism-extend')(Prism);

const html = (code, lang = 'bash') => Prism.highlight(code, Prism.languages[lang], lang);
const commands = (h) => [...h.matchAll(/class="token function( command)?">([^<]+)</g)].map((m) => m[2]);
const params = (h) => [...h.matchAll(/class="token parameter variable">([^<]+)</g)].map((m) => m[1]);

test('ismeretlen parancsok parancs pozícióban (sor elején, |, &&, $(…), sudo után)', () => {
  const h = html('FOO=bar kubectl get pods | grep x && helm upgrade app\nr=$(terraform output -raw ip)\nsudo systemctl restart nginx\n./deploy.sh --dry-run');
  assert.deepEqual(commands(h), ['kubectl', 'grep', 'helm', 'terraform', 'sudo', 'systemctl', './deploy.sh']);
});

test('argumentum nem lesz parancs (pl. "ip", "nginx")', () => {
  const h = html('terraform output -raw ip\nsystemctl restart nginx');
  assert.ok(!commands(h).includes('ip'));
  assert.ok(!commands(h).includes('nginx'));
});

test('sorfolytatás (\\) utáni sor első szava nem parancs', () => {
  const h = html('docker run --rm \\\n  nginx:latest');
  assert.deepEqual(commands(h), ['docker']);
});

test('kapcsolók, kötőjeles nevekkel és ; előtt is', () => {
  assert.deepEqual(params(html('rm -rf x --no-preserve-root; ls -la')), ['-rf', '--no-preserve-root', '-la']);
});

test('aliasok', () => {
  for (const [a, t] of [['sh', 'bash'], ['shell', 'bash'], ['yml', 'yaml'], ['py', 'python']]) {
    assert.equal(Prism.languages[a], Prism.languages[t], a);
  }
});
