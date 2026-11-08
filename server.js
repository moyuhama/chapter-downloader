import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { helperHome } from './service-state.js';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { Crawler, httpUrl } from './crawler.js';
import { Jobs } from './jobs.js';
import { PdfQueue } from './pdf-queue.js';
import { LocalPdf, scanImageDirectory } from './local-pdf.js';
import { allowRequest } from './access.js';
import { Reader } from './reader.js';
import { FolderRenamer, renamedPath } from './folder-rename.js';
import { defaultDownloadDirectory, chooseDirectory } from './directories.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const runtimeRoot = process.env.SHIYE_HOME ? helperHome() : root;
const instanceId = randomUUID();
let stopping = false;
const crawler = new Crawler(path.join(runtimeRoot, 'data'));
const pdfQueue = new PdfQueue();
const converter = new LocalPdf({ pdfQueue });
const jobs = new Jobs(runtimeRoot, crawler, { pdfQueue }); await jobs.init();
const reader = new Reader({stateDirectory:path.join(runtimeRoot,'data'),publicDirectory:path.join(root,'public')}); await reader.init();
const renamer = new FolderRenamer();
let renameBusy = false;
const canonical=async value=>value?await fs.realpath(value).catch(()=>path.resolve(value)):value;
const overlaps=(a,b)=>{if(!a||!b)return false;const inside=(p,q)=>{const r=path.relative(p,q);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};return inside(a,b)||inside(b,a);};
let readerBusy = false;
let browserBusy = false;
async function exclusive(fn) { if (browserBusy || jobs.running.size || [...jobs.jobs.values()].some(j => ['queued', 'running', 'paused'].includes(j.status))) throw new Error('浏览器正在处理其他操作，请完成或停止后再试'); browserBusy = true; try { return await fn(); } finally { browserBusy = false; } }
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2e6) throw new Error('请求过大'); } return data ? JSON.parse(data) : {}; }
async function rules() { try { return JSON.parse(await fs.readFile(path.join(runtimeRoot, 'data/rules.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
async function servePdf(res, file) {
  const stat = await fs.stat(file);
  const filename = encodeURIComponent(path.basename(file)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length':stat.size, 'Content-Disposition':`inline; filename*=UTF-8''${filename}`, 'X-Content-Type-Options':'nosniff' });
  await pipeline(createReadStream(file),res).catch(()=>res.destroy());
}
const server = http.createServer(async (req, res) => {
  try {
    if (!allowRequest(req, res)) return json(res, 403, { error: '仅允许本机界面或已配置的 GitHub Pages 页面访问' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost'); const p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, app: 'chapter-downloader', version, instanceId, state: stopping ? 'stopping' : 'ready', capabilities: { shutdown: true, reader: true, folderRename: true } });
    if (req.method === 'GET' && p === '/api/reader/source') return json(res,200,{source:reader.book?.directory||''});
    if (req.method === 'GET' && p === '/api/reader/share') return json(res,200,reader.shareStatus());
    if (req.method === 'GET' && p.startsWith('/api/reader/')) return await reader.read(req,res,url);
    if (req.method === 'GET' && p === '/api/download-settings') return json(res, 200, { directory: defaultDownloadDirectory, separator: path.sep });
    const conversion = p.match(/^\/api\/conversions\/([^/]+)(?:\/(pdf|stop|open))?$/);
    if (req.method === 'GET' && conversion) {
      const task = converter.get(conversion[1]);
      if (conversion[2] === 'pdf') {
        if(task.status!=='completed')return json(res,404,{error:'PDF 尚未生成完成'});
        await servePdf(res, task.output); return;
      }
      return json(res,200,task);
    }
    const pdfRequest = p.match(/^\/api\/jobs\/([^/]+)\/chapters\/(\d+)\/pdf$/);
    if (req.method === 'GET' && pdfRequest) {
      const job = jobs.jobs.get(pdfRequest[1]);
      const chapter = job?.chapters.find(c => c.number === Number(pdfRequest[2]));
      if (!chapter || chapter.pdf?.status !== 'completed') return json(res, 404, { error: 'PDF 尚未生成完成' });
      const file = path.join(job.output, chapter.folder, chapter.pdf.file);
      await servePdf(res, file); return;
    }
    if (req.method === 'GET' && p === '/api/jobs') return json(res, 200, jobs.list());
    if (req.method === 'GET' && p === '/api/rules') return json(res, 200, (await rules())[new URL(httpUrl(url.searchParams.get('url'))).hostname] || {});
    if (req.method === 'POST' && p.startsWith('/api/')) {
      const b = await body(req);
      if (p === '/api/service/stop') {
        if (b.instanceId !== instanceId) return json(res,409,{error:'服务实例已变化，请重新连接后再停止'});
        json(res,200,{ok:true,state:'stopping'});setTimeout(()=>shutdown(),25);return;
      }
      if (stopping) return json(res,503,{error:'服务正在停止'});
      if (p === '/api/rename/preview' || p === '/api/rename/apply') {
        if(renameBusy)throw new Error('正在处理文件夹改名，请稍候');renameBusy=true;
        try {
          if(p === '/api/rename/preview')return json(res,200,await renamer.preview(b.source));
          const directory=renamer.plan?.directory;
          if(readerBusy)throw new Error('阅读器正在切换作品，请稍后重试');
          const jobPaths=await Promise.all([...jobs.jobs.values()].map(async job=>({job,output:await canonical(job.output)})));
          const conversionPaths=converter.current?Object.fromEntries(await Promise.all(['source','directory','output'].map(async key=>[key,await canonical(converter.current[key])]))):{};
          if(jobs.creating||converter.creating||jobPaths.some(({job,output})=>(jobs.running.has(job.id)||['queued','running','paused'].includes(job.status))&&overlaps(directory,output)) || (converter.busy&&(overlaps(directory,conversionPaths.source)||overlaps(directory,conversionPaths.directory))))throw new Error('此目录正在下载或转换，请完成或停止任务后再改名');
          const previous=reader.book?.directory;
          const result=await renamer.apply(b.id,b.changes);
          if(result.changed) {
            let updated=false;
            for(const {job,output:old} of jobPaths) {
              const next=renamedPath(old,directory,result.rows);
              for(const chapter of job.chapters){const original=path.join(old,chapter.folder),moved=renamedPath(original,directory,result.rows);if(moved!==original){chapter.folder=path.relative(next,moved);updated=true;}}
              if(next!==old){job.output=next;job.directory=path.dirname(next);job.folderName=path.basename(next);updated=true;}
            }
            if(updated){try{await jobs.persist();}catch(e){result.warning='目录已改名，但下载索引保存失败，请勿继续下载并检查磁盘权限：'+e.message;}}
            if(converter.current)for(const field of ['source','directory','output']){const moved=renamedPath(conversionPaths[field],directory,result.rows);if(moved!==conversionPaths[field])converter.current[field]=moved;}
          }
          if(result.changed&&previous&&overlaps(directory,previous)) {
            const source=renamedPath(previous,directory,result.rows);
            try{await reader.open(source);result.warning=(result.warning||'')+'阅读器目录已刷新，手机分享链接已关闭；请重新打开阅读器。';}
            catch{await reader.stopShare();reader.book=null;result.warning=(result.warning||'')+'请在阅读器中重新选择改名后的作品。';}
          }
          return json(res,200,result);
        } finally {renameBusy=false;}
      }
      if(renameBusy&&['/api/jobs','/api/conversions','/api/reader/open','/api/reader/share'].includes(p))throw new Error('正在重命名文件夹，请稍候');
      if(renameBusy&&/^\/api\/jobs\/[^/]+\/(resume|retry-pdf)$/.test(p))throw new Error('正在重命名文件夹，请稍候');
      if (p === '/api/reader/open' || p === '/api/reader/share') {
        if(readerBusy)throw new Error('阅读器正在处理操作，请稍候');readerBusy=true;
        try {
          if(p === '/api/reader/open') {
            const source=b.jobId ? jobs.jobs.get(b.jobId)?.output : b.source;
            return json(res,200,await reader.open(source));
          }
          if(b.enabled===true)return json(res,200,await reader.startShare());
          await reader.stopShare();return json(res,200,reader.shareStatus());
        } finally {readerBusy=false;}
      }
      if (p === '/api/local-images') return json(res,200,await scanImageDirectory(b.source));
      if (p === '/api/conversions') return json(res,200,await converter.create(b));
      if (conversion) {
        if(conversion[2]==='stop')return json(res,200,converter.stop(conversion[1]));
        if(conversion[2]==='open'){
          const task=converter.get(conversion[1]);await fs.access(task.directory);
          const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
          const child=spawn(command,[task.directory],{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();return json(res,200,{path:task.directory});
        }
        return json(res,404,{error:'接口不存在'});
      }
      if (p === '/api/choose-directory') return json(res, 200, { directory: await chooseDirectory() });
      if (p === '/api/parse') return json(res, 200, await exclusive(() => crawler.catalog(httpUrl(b.url), b.options)));
      if (p === '/api/preview') return json(res, 200, await exclusive(async () => {
        const images = await crawler.chapter(httpUrl(b.url), { ...b.options, followPages: false }, async () => {});
        return { count: images.length, images: images.slice(0, 8).map(i => i.url), note: '预览仅检查本章第一页，下载时会继续读取分页。' };
      }));
      if (p === '/api/pick') return json(res, 200, await exclusive(() => crawler.pick(httpUrl(b.url), b.kind === 'chapter' ? 'chapter' : 'image')));
      if (p === '/api/login') return json(res, 200, await exclusive(async () => { const page = await crawler.page(httpUrl(b.url)); await page.bringToFront(); return { message: '已打开浏览器，请手动登录。登录完成后回到此处重新解析。' }; }));
      if (p === '/api/rules') { const all = await rules(); all[new URL(httpUrl(b.url)).hostname] = b.options; await fs.writeFile(path.join(runtimeRoot, 'data/rules.json'), JSON.stringify(all, null, 2)); return json(res, 200, { ok: true }); }
      if (p === '/api/jobs') { if (browserBusy) throw new Error('浏览器操作尚未结束'); return json(res, 200, await jobs.create(b)); }
      const m = p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|stop|open|retry-pdf)$/);
      if (m) {
        if (m[2] === 'open') {
          const job = jobs.jobs.get(m[1]); if (!job) throw new Error('任务不存在'); await fs.access(job.output);
          const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
          const child = spawn(cmd, [job.output], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); return json(res, 200, { path: job.output });
        }
        if (browserBusy && ['resume','retry-pdf'].includes(m[2])) throw new Error('浏览器操作尚未结束');
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
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/helper-release.json': ['helper-release.json','application/json'], '/reader.html':['reader.html','text/html; charset=utf-8'], '/reader.js':['reader.js','text/javascript'], '/reader.css':['reader.css','text/css'], '/rename.html':['rename.html','text/html; charset=utf-8'], '/rename.js':['rename.js','text/javascript'] };
    if (!assets[p]) return json(res, 404, { error: '页面不存在' });
    const [file, mime] = assets[p]; res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' }); res.end(await fs.readFile(path.join(root, 'public', file)));
  } catch (e) { json(res, 400, { error: e.message }); }
});
const port = Number(process.env.PORT || 3789);
server.listen(port, '127.0.0.1', () => console.log(`章节采集器：http://127.0.0.1:${port}`));
server.on('error', e => { console.error(e.message); process.exit(1); });
async function shutdown() {
  if(stopping)return;stopping=true;
  const active=[...jobs.jobs.values()].filter(j=>['running','paused','queued'].includes(j.status));
  for(const j of active)j.status='stopped';
  if(converter.busy&&converter.current)converter.stop(converter.current.id);
  const deadline=setTimeout(()=>process.exit(1),35000);deadline.unref();
  try {
    await reader.stopShare();
    await crawler.close();
    const end=Date.now()+30000;
    while((jobs.running.size||converter.busy||browserBusy||renameBusy)&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
    for(const j of active)j.status='interrupted';
    await jobs.persist();
  } finally {
    server.close(()=>process.exit(0));server.closeIdleConnections();
    setTimeout(()=>{server.closeAllConnections();process.exit(0);},1000).unref();
  }
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>shutdown());
