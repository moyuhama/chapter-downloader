import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../jobs.js';
import { sleep } from '../crawler.js';
const gate = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };
async function until(fn) { const deadline=Date.now()+5000; while(!fn()){if(Date.now()>deadline)throw new Error('Timed out waiting for job');await sleep(10);} }
const input=(n=4,extra={})=>({url:'https://example.com/book',title:'并发测试',chapters:Array.from({length:n},(_,i)=>({title:`第${i+1}章`,url:`https://example.com/ch/${i+1}`})),...extra});
async function setup(crawler) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chapter-concurrency-'));
  const jobs=new Jobs(root,crawler,{defaultDirectory:path.join(root,'Downloads')});await jobs.init();
  return {jobs,root,close:()=>fs.rm(root,{recursive:true,force:true})};
}
const images=(url,n=2)=>Array.from({length:n},(_,i)=>({url:`${url}/${i+1}.png`,pageUrl:url}));
const bytes=async img=>({type:'image/png',body:Buffer.from(img.url)});

test('defaults to two overlapping chapters, limits concurrency, and preserves numbering when later chapters finish first',async()=>{
  const gates=Array.from({length:4},gate),started=[],finished=[];let active=0,maxActive=0;
  const {jobs,close}=await setup({chapter:async url=>{const n=Number(url.split('/').pop());started.push(n);await gates[n-1].promise;return images(url);},bytes});
  const original=jobs.processChapter.bind(jobs);jobs.processChapter=async(j,c,urls)=>{active++;maxActive=Math.max(maxActive,active);try{await original(j,c,urls);finished.push(c.number);}finally{active--;}};
  try{
    const result=await jobs.create(input());const j=jobs.jobs.get(result.id);assert.equal(j.chapterConcurrency,2);
    await until(()=>started.length===2);assert.deepEqual(started,[1,2]);assert.equal(active,2);
    gates[1].resolve();await until(()=>started.includes(3));assert.equal(j.chapters[0].status,'running');
    gates[2].resolve();await until(()=>started.includes(4));gates[3].resolve();await until(()=>finished.length===3);
    gates[0].resolve();await until(()=>!jobs.running.has(j.id));
    assert.equal(maxActive,2);assert.deepEqual(finished,[2,3,4,1]);assert.equal(j.status,'completed');assert.equal(j.done,8);
    for(const c of j.chapters){assert.ok(c.folder.startsWith(String(c.number).padStart(3,'0')+'_'));assert.deepEqual(c.images.map(i=>i.file),['001.png','002.png']);for(const i of c.images)assert.equal(await fs.readFile(path.join(j.output,c.folder,i.file),'utf8'),i.url);}
  }finally{gates.forEach(g=>g.resolve());await until(()=>jobs.running.size===0);await close();}
});

test('pause stops image work in every active chapter and resume starts the remaining chapters',async()=>{
  const gates=[gate(),gate()];let started=0,downloads=0;
  const {jobs,close}=await setup({chapter:async url=>{const index=started++;if(index<2)await gates[index].promise;return images(url);},bytes:async img=>{downloads++;return bytes(img);}});
  try{
    const result=await jobs.create(input(3));const j=jobs.jobs.get(result.id);await until(()=>started===2);
    await jobs.control(j.id,'pause');gates.forEach(g=>g.resolve());await until(()=>j.chapters.filter(c=>c.images.length).length===2);
    assert.equal(j.status,'paused');assert.equal(downloads,0);assert.equal(started,2);
    await jobs.control(j.id,'resume');await until(()=>!jobs.running.has(j.id));assert.equal(j.status,'completed');assert.equal(downloads,6);assert.equal(started,3);
  }finally{gates.forEach(g=>g.resolve());for(const j of jobs.jobs.values())if(j.status==='paused')await jobs.control(j.id,'stop');await until(()=>jobs.running.size===0);await close();}
});

test('stop drains all active chapters before a new task can start; resume skips finished images',async()=>{
  const inflight=gate();let calls=0,chapters=0;
  const {jobs,close}=await setup({chapter:async url=>{chapters++;return images(url,3);},bytes:async img=>{calls++;await inflight.promise;return bytes(img);}});
  try{
    const result=await jobs.create(input(4));const j=jobs.jobs.get(result.id);await until(()=>calls===6);
    await jobs.control(j.id,'stop');await assert.rejects(jobs.create(input(1)),/完成或停止/);
    inflight.resolve();await until(()=>!jobs.running.has(j.id));assert.equal(j.status,'stopped');assert.equal(chapters,2);
    await jobs.control(j.id,'resume');await until(()=>!jobs.running.has(j.id));assert.equal(j.status,'completed');assert.equal(j.done,12);assert.equal(calls,12);assert.equal(chapters,4);
  }finally{inflight.resolve();await until(()=>jobs.running.size===0);await close();}
});

test('one failed chapter does not stop its peers; retry only reprocesses the failed chapter',async()=>{
  let fail=true;const attempts=new Map();
  const {jobs,close}=await setup({chapter:async url=>{attempts.set(url,(attempts.get(url)||0)+1);if(url.endsWith('/1')&&fail)throw new Error('chapter failed');return images(url);},bytes});
  try{
    const result=await jobs.create(input(3));const j=jobs.jobs.get(result.id);await until(()=>!jobs.running.has(j.id));
    assert.equal(j.status,'partial');assert.equal(j.chapters[0].status,'failed');assert.equal(j.done,4);
    fail=false;await jobs.control(j.id,'resume');await until(()=>!jobs.running.has(j.id));assert.equal(j.status,'completed');assert.equal(j.done,6);
    assert.deepEqual([...attempts.values()],[2,1,1]);
  }finally{await until(()=>jobs.running.size===0);await close();}
});

test('supports serial processing and validates the concurrency setting',async()=>{
  let active=0,peak=0;
  const {jobs,close}=await setup({chapter:async url=>{active++;peak=Math.max(peak,active);await sleep(10);active--;return images(url);},bytes});
  try{
    for(const chapterConcurrency of [0,-1,5,1.5,'invalid'])await assert.rejects(jobs.create(input(1,{chapterConcurrency})),/并发数/);
    const result=await jobs.create(input(3,{chapterConcurrency:1}));await until(()=>!jobs.running.has(result.id));assert.equal(peak,1);assert.equal(jobs.jobs.get(result.id).status,'completed');
  }finally{await until(()=>jobs.running.size===0);await close();}
});
