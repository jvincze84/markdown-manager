#!/bin/sh
# PWA ikonok (PNG) generálása a public/icons/*.svg forrásokból, a tesztekhez is használt Playwright image
# Chromiumával (helyben nem kell semmi). Futtatás a repó gyökeréből: scripts/make-icons.sh
set -e
cd "$(dirname "$0")/.."
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/public/icons:/icons" -v "$PWD/tests/e2e:/e2e:ro" \
  mcr.microsoft.com/playwright:v1.56.0-noble sh -c 'cd /tmp && cp /e2e/package*.json . \
  && npm ci --loglevel=error --no-audit --no-fund --cache /tmp/npm >/dev/null && node -e "
const { chromium } = require(\"@playwright/test\");
const fs = require(\"fs\");
const jobs = [
  [\"icon.svg\", 192, \"icon-192.png\"], [\"icon.svg\", 512, \"icon-512.png\"], [\"icon.svg\", 32, \"favicon-32.png\"],
  [\"icon-maskable.svg\", 512, \"icon-maskable-512.png\"], [\"icon-maskable.svg\", 180, \"apple-touch-icon.png\"],
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [src, size, out] of jobs) {
    const svg = fs.readFileSync(\"/icons/\" + src, \"utf8\");
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(\"<style>html,body{margin:0;background:transparent}svg{display:block;width:\" + size + \"px;height:\" + size + \"px}</style>\" + svg);
    await page.screenshot({ path: \"/icons/\" + out, omitBackground: true });
    console.log(\"wrote\", out, size + \"x\" + size);
  }
  await browser.close();
})();
"'
