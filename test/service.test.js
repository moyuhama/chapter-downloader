import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const run=promisify(execFile);const cli=fileURLToPath(new URL('../launcher/cli.mjs',import.meta.url));
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('CLI starts independently in a fixed data directory, reuses its instance, and stops only the current service', {timeout:45000},async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-service-'));const port=await freePort();
  const env={...process.env,SHIYE_HOME:home,PORT:String(port)};
  try{
    const first=JSON.parse((await run(process.execPath,[cli,'start'],{env,timeout:25000})).stdout);
    assert.equal(first.app,'chapter-downloader');assert.equal(first.state,'ready');assert.equal(first.capabilities.shutdown,true);
    const second=JSON.parse((await run(process.execPath,[cli,'start'],{env,timeout:10000})).stdout);assert.equal(second.instanceId,first.instanceId);assert.equal(second.reused,true);
    const bad=await fetch(`http://127.0.0.1:${port}/api/service/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:'stale'})});assert.equal(bad.status,409);
    const foreign=await fetch(`http://127.0.0.1:${port}/api/service/stop`,{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:JSON.stringify({instanceId:first.instanceId})});assert.equal(foreign.status,403);
    await run(process.execPath,[cli,'stop'],{env,timeout:10000});
    const status=JSON.parse((await run(process.execPath,[cli,'status'],{env,timeout:10000})).stdout);assert.equal(status.state,'stopped');
    assert.equal((await fs.stat(path.join(home,'data','jobs.json'))).isFile(),true);
  }finally{await run(process.execPath,[cli,'stop'],{env,timeout:10000}).catch(()=>{});await fs.rm(home,{recursive:true,force:true});}
});
test('folder rename updates downloaded chapter/PDF paths and the current reader, including after restarting the service',{timeout:45000},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-rename-service-'));const home=path.join(temp,'home'),downloads=path.join(temp,'downloads'),book=path.join(downloads,'第100章-作品'),folder='001_第85話-标题';
  await fs.mkdir(path.join(home,'data'),{recursive:true});await fs.mkdir(path.join(book,folder),{recursive:true});
  const image=await sharp({create:{width:20,height:30,channels:3,background:'#abc'}}).png().toBuffer();await fs.writeFile(path.join(book,folder,'001.png'),image);await fs.writeFile(path.join(book,folder,'chapter.pdf'),'fixture PDF');
  await fs.writeFile(path.join(home,'data','jobs.json'),JSON.stringify([{id:'fixture',status:'completed',title:'作品',output:book,directory:downloads,folderName:path.basename(book),chapters:[{number:1,title:'第85話',folder,status:'completed',images:[{file:'001.png',status:'done'}],pdf:{status:'completed',file:'chapter.pdf'}}]}]));
  const port=await freePort();const env={...process.env,SHIYE_HOME:home,PORT:String(port)};const base=`http://127.0.0.1:${port}`;
  const post=async(p,b)=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,200);return r.json();};
  try{
    await run(process.execPath,[cli,'start'],{env,timeout:25000});await post('/api/reader/open',{source:book});
    let plan=await post('/api/rename/preview',{source:book});let result=await post('/api/rename/apply',{id:plan.id,changes:[{id:plan.rows[0].id,to:'85'}]});assert.equal(result.ok,true);assert.match(result.warning,/阅读器目录已刷新/);
    let jobs=await(await fetch(base+'/api/jobs')).json();assert.equal(jobs[0].chapters[0].folder,'85');assert.equal(await(await fetch(base+'/api/jobs/fixture/chapters/1/pdf')).text(),'fixture PDF');
    assert.equal((await(await fetch(base+'/api/reader/book')).json()).chapters[0].title,'85');
    plan=await post('/api/rename/preview',{source:downloads});result=await post('/api/rename/apply',{id:plan.id,changes:[{id:plan.rows[0].id,to:'100'}]});assert.equal(result.ok,true);
    await run(process.execPath,[cli,'stop'],{env,timeout:10000});await run(process.execPath,[cli,'start'],{env,timeout:25000});
    jobs=await(await fetch(base+'/api/jobs')).json();assert.equal(jobs[0].output,await fs.realpath(path.join(downloads,'100')));assert.equal(jobs[0].folderName,'100');assert.equal(jobs[0].chapters[0].folder,'85');
    const source=await(await fetch(base+'/api/reader/source')).json();assert.equal(source.source,await fs.realpath(path.join(downloads,'100')));assert.deepEqual(await fs.readFile(path.join(downloads,'100','85','001.png')),image);
  }finally{await run(process.execPath,[cli,'stop'],{env,timeout:10000}).catch(()=>{});await fs.rm(temp,{recursive:true,force:true});}
});
