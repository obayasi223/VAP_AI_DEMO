#!/usr/bin/env node
// Three.js ページを Playwright Chromium のソフトウェア描画（SwiftShader）で回す。
// 実機の GPU 描画より CPU をはるかに多く使うので、負荷としては実機より重い側の再現である。
// 使い方: node run_load_page.mjs --pw <playwright のあるディレクトリ> --three <node_modules/three> \
//           [--model file.vrm] [--seconds 340] [--out result.json] [--shot shot.png] [--width 1280 --height 720]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ')]; }));
const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(args.pw, 'package.json'))('playwright');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.vrm': 'model/gltf-binary' };
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  try {
    const f = u === '/' ? join(here, 'index.html') : u === '/model.vrm' ? args.model : u.startsWith('/three/') ? join(args.three, u.slice(7)) : null;
    if (!f) throw new Error('nf');
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
function cpuBusy() {
  const v = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + v[4];
  return { idle, total: v.reduce((a, b) => a + b, 0) };
}
const width = Number(args.width || 1280), height = Number(args.height || 720);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width, height } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`http://127.0.0.1:${port}/${args.model ? '?model=/model.vrm' : ''}`);
await p.waitForFunction('window.__ready === true', null, { timeout: 120000 });
console.log('ready', new Date().toISOString());
const c0 = cpuBusy();
const secs = Number(args.seconds || 60);
await new Promise((r) => setTimeout(r, secs * 1000));
const c1 = cpuBusy();
const stats = await p.evaluate('window.__stats()');
if (args.shot) await p.screenshot({ path: args.shot });
await b.close();
srv.close();
const out = { seconds: secs, width, height, software_rendering: true, ...stats,
  system_cpu_busy_fraction: 1 - (c1.idle - c0.idle) / (c1.total - c0.total), page_errors: errs };
console.log(JSON.stringify(out));
if (args.out) await writeFile(args.out, JSON.stringify(out, null, 1) + '\n');
