import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Crawler, safeName, httpUrl, sleep } from '../crawler.js';
import { Jobs } from '../jobs.js';

test('folder names and URL validation', () => {
  assert.equal(safeName('../第一章/图片?'), '_第一章_图片_');
  assert.throws(()=>httpUrl('file:///etc/passwd'));
  assert.throws(()=>httpUrl('https://name:pass@example.com/'));
  assert.equal(httpUrl('https://example.com/a#part'), 'https://example.com/a');
});

test('real browser: chapter order, lazy image order, pagination, retry, persistence and resume', {timeout:120000}, async () => {
  process.env.CRAWLER_HEADLESS = '1';
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'chapter-downloader-'));
  const hits = {}; let fail = true;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV7sAAAAASUVORK5CYII=', 'base64');
  const server = http.createServer(async (req,res)=>{
    hits[req.url] = (hits[req.url] || 0)+1;
    if(req.url.startsWith('/image/')) {
      if(req.url === '/image/2' && fail) { res.writeHead(503);res.end('try again');return; }
      await sleep(req.url === '/image/1' ? 90 : 5);
      res.writeHead(200,{'Content-Type':'image/png'});res.end(png);return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    if(req.url === '/') res.end('<h1>测试作品</h1><nav><a href="/home">首页</a></nav><ul><li><a href="/ch/2">第2章</a></li><li><a href="/ch/1">第1章</a></li><li><a href="/ch/2#duplicate">第2章</a></li></ul>');
    else if(req.url === '/ch/2') res.end('<main><img data-src="/image/1"><img src="/image/2"><img src="/image/1"></main><a href="/ch/2?page=2">下一页</a>');
    else if(req.url === '/ch/2?page=2') res.end('<main><img src="/image/3"></main><a href="/ch/1">下一章</a>');
    else res.end('<article><img src="/image/4"></article>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const crawler = new Crawler(path.join(root,'profile'));
  try {
    const parsed = await crawler.catalog(base);
    assert.deepEqual(parsed.chapters.map(c=>c.title),['第2章','第1章']);
    const jobs = new Jobs(root,crawler,{defaultDirectory:path.join(root,'downloads')});await jobs.init();
    const created = await jobs.create({title:parsed.title,url:base,chapters:parsed.chapters,options:{minWidth:0,minHeight:0}});
    const job = jobs.jobs.get(created.id);
    while(jobs.running.has(job.id)) await sleep(100);
    assert.equal(job.status,'partial'); assert.equal(job.done,3); assert.equal(job.failed,1);assert.equal(job.total,4);
    assert.deepEqual(job.chapters[0].images.map(i=>i.url),[1,2,3].map(n=>base+'/image/'+n));
    assert.equal(job.chapters[0].images[0].file,'001.png');assert.equal(job.chapters[0].images[2].file,'003.png');
    const doneHits = hits['/image/1']; fail=false;
    await jobs.control(job.id,'resume'); while(jobs.running.has(job.id)) await sleep(100);
    assert.equal(job.status,'completed');assert.equal(job.done,4);assert.equal(job.failed,0);assert.equal(hits['/image/1'],doneHits);
    for(const c of job.chapters) for(const i of c.images) assert.deepEqual(await fs.readFile(path.join(job.output,c.folder,i.file)),png);
    const restored = new Jobs(root,crawler,{defaultDirectory:path.join(root,'downloads')});await restored.init();assert.equal(restored.list()[0].status,'completed');
    job.status='paused';await jobs.persist();const interrupted=new Jobs(root,crawler,{defaultDirectory:path.join(root,'downloads')});await interrupted.init();assert.equal(interrupted.list()[0].status,'interrupted');
  } finally {await crawler.close();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
});

test('stop, pause and resume keep completed files and workers do not race at end of queue', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chapter-jobs-')); let calls=0;
  const fake={chapter:async()=>Array.from({length:4},(_,i)=>({url:`https://example.com/${i}.png`,pageUrl:'https://example.com/ch'})),bytes:async()=>{calls++;await sleep(80);return {type:'image/png',body:Buffer.from('test')};}};
  const jobs=new Jobs(root,fake,{defaultDirectory:path.join(root,'downloads')});await jobs.init();
  try {
    const result=await jobs.create({url:'https://example.com',title:'test',chapters:[{title:'第1章',url:'https://example.com/ch'}]});
    const job=jobs.jobs.get(result.id);
    while(calls<1) await sleep(10);await jobs.control(job.id,'pause');
    await sleep(150);const pausedCalls=calls;await sleep(100);assert.equal(calls,pausedCalls);
    await jobs.control(job.id,'stop');while(jobs.running.has(job.id)) await sleep(10);assert.equal(job.status,'stopped');
    await jobs.control(job.id,'resume');while(jobs.running.has(job.id)) await sleep(10);assert.equal(job.status,'completed');assert.equal(job.done,4);assert.equal(calls,4);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
