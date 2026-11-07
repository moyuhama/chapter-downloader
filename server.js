import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Crawler, httpUrl } from './crawler.js';
import { Jobs } from './jobs.js';
import { allowRequest } from './access.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const crawler = new Crawler(path.join(root, 'data'));
const jobs = new Jobs(root, crawler); await jobs.init();
let browserBusy = false;
async function exclusive(fn) { if (browserBusy || [...jobs.jobs.values()].some(j => ['queued', 'running', 'paused'].includes(j.status))) throw new Error('浏览器正在处理其他操作，请完成或停止后再试'); browserBusy = true; try { return await fn(); } finally { browserBusy = false; } }
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2e6) throw new Error('请求过大'); } return data ? JSON.parse(data) : {}; }
async function rules() { try { return JSON.parse(await fs.readFile(path.join(root, 'data/rules.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
const server = http.createServer(async (req, res) => {
  try {
    if (!allowRequest(req, res)) return json(res, 403, { error: '仅允许本机界面或已配置的 GitHub Pages 页面访问' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost'); const p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, app: 'chapter-downloader' });
    if (req.method === 'GET' && p === '/api/jobs') return json(res, 200, jobs.list());
    if (req.method === 'GET' && p === '/api/rules') return json(res, 200, (await rules())[new URL(httpUrl(url.searchParams.get('url'))).hostname] || {});
    if (req.method === 'POST' && p.startsWith('/api/')) {
      const b = await body(req);
      if (p === '/api/parse') return json(res, 200, await exclusive(() => crawler.catalog(httpUrl(b.url), b.options)));
      if (p === '/api/preview') return json(res, 200, await exclusive(async () => {
        const images = await crawler.chapter(httpUrl(b.url), { ...b.options, followPages: false }, async () => {});
        return { count: images.length, images: images.slice(0, 8).map(i => i.url), note: '预览仅检查本章第一页，下载时会继续读取分页。' };
      }));
      if (p === '/api/pick') return json(res, 200, await exclusive(() => crawler.pick(httpUrl(b.url), b.kind === 'chapter' ? 'chapter' : 'image')));
      if (p === '/api/login') return json(res, 200, await exclusive(async () => { const page = await crawler.page(httpUrl(b.url)); await page.bringToFront(); return { message: '已打开浏览器，请手动登录。登录完成后回到此处重新解析。' }; }));
      if (p === '/api/rules') { const all = await rules(); all[new URL(httpUrl(b.url)).hostname] = b.options; await fs.writeFile(path.join(root, 'data/rules.json'), JSON.stringify(all, null, 2)); return json(res, 200, { ok: true }); }
      if (p === '/api/jobs') { if (browserBusy) throw new Error('浏览器操作尚未结束'); return json(res, 200, await jobs.create(b)); }
      const m = p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|stop|open)$/);
      if (m) {
        if (m[2] === 'open') {
          const job = jobs.jobs.get(m[1]); if (!job) throw new Error('任务不存在'); await fs.access(job.output);
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
          const child = spawn(cmd, [job.output], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); return json(res, 200, { path: job.output });
        }
        if (browserBusy && m[2] === 'resume') throw new Error('浏览器操作尚未结束');
        return json(res, 200, await jobs.control(m[1], m[2]));
      }
      return json(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: '不支持的方法' });
    if (p === '/demo/') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end('<!doctype html><meta charset="utf-8"><title>示例作品 · 山间散记</title><main><h1>示例作品 · 山间散记</h1><p>这是内置的本地测试目录，包含 3 章，每章 3 张图片。</p><ul>' + [1,2,3].map(n => `<li><a href="/demo/chapter/${n}">第${n}章 · 山间记忆</a></li>`).join('') + '</ul></main>');
    }
    const demoChapter = p.match(/^\/demo\/chapter\/([123])$/);
    if (demoChapter) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end('<!doctype html><meta charset="utf-8"><title>第' + demoChapter[1] + '章</title><style>body{margin:auto;max-width:800px;background:#f1f3eb}img{display:block;width:100%;margin:20px 0}</style><main>' + [1,2,3].map(n => `<img loading="lazy" src="/demo/image/${demoChapter[1]}-${n}.svg" alt="第${n}张">`).join('') + '</main>');
    }
    const demoImage = p.match(/^\/demo\/image\/([123])-([123])\.svg$/);
    if (demoImage) {
      res.writeHead(200, {'Content-Type':'image/svg+xml'});
      const n = Number(demoImage[1]) * 3 + Number(demoImage[2]);
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100"><rect width="800" height="1100" fill="#e8efdf"/><circle cx="600" cy="230" r="80" fill="#cedb98"/><path d="M0 850L280 ${300+n*12}L650 850Z" fill="#a9bd91"/><path d="M170 950L570 ${480+n*8}L900 950Z" fill="#52765c"/><text x="65" y="105" font-size="25" fill="#52765c" font-family="sans-serif">PAGE COLLECTOR / CHAPTER ${demoImage[1]}</text><text x="65" y="1030" font-size="40" fill="#52765c" font-family="monospace">PAGE 00${demoImage[2]}</text></svg>`);
    }
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
    if (!assets[p]) return json(res, 404, { error: '页面不存在' });
    const [file, mime] = assets[p]; res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' }); res.end(await fs.readFile(path.join(root, 'public', file)));
  } catch (e) { json(res, 400, { error: e.message }); }
});
const port = Number(process.env.PORT || 3789);
server.listen(port, '127.0.0.1', () => console.log(`章节采集器：http://127.0.0.1:${port}`));
server.on('error', e => { console.error(e.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { for (const j of jobs.jobs.values()) if (['running','paused','queued'].includes(j.status)) j.status = 'interrupted'; await jobs.persist(); await crawler.close(); server.close(); process.exit(0); });
