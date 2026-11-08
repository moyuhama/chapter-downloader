import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),command=fileURLToPath(new URL('../停止服务.command',import.meta.url)),cli=fileURLToPath(new URL('../launcher/cli.mjs',import.meta.url));
const mac={skip:process.platform!=='darwin',timeout:45000};
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
test('double-click stop works outside the project without Node on PATH, preserves data and tolerates already stopped services',mac,async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-command-'));const port=await freePort(),env={...process.env,PORT:String(port),SHIYE_HOME:home,SHIYE_STOP_NO_PAUSE:'1'};
  try{
    await run(process.execPath,[cli,'start'],{env,timeout:25000});
    const extracted=path.join(home,'tools');await run('/usr/bin/ditto',['-x','-k',fileURLToPath(new URL('../public/shiye-stop-macos.zip',import.meta.url)),extracted]);
    const portable=path.join(extracted,'停止服务.command');assert.equal((await fs.stat(portable)).mode&0o111,0o111);
    const result=await run(portable,[],{cwd:os.tmpdir(),env:{...env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},timeout:43000});assert.match(result.stdout,/拾页服务已停止/);
    assert.equal(JSON.parse((await run(process.execPath,[cli,'status'],{env})).stdout).state,'stopped');assert.ok(await fs.stat(path.join(home,'data','jobs.json')));
    assert.match((await run('/bin/zsh',[command],{env,timeout:5000})).stdout,/未运行，或已经停止/);
  }finally{await run(process.execPath,[cli,'stop'],{env,timeout:10000}).catch(()=>{});await fs.rm(home,{recursive:true,force:true});}
});
test('stop command refuses unrelated programs and old services without sending a stop request',mac,async()=>{
  let app='other-app',posts=0;
  const s=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app}));});await new Promise(r=>s.listen(0,'127.0.0.1',r));
  try{
    const env={...process.env,PORT:String(s.address().port),SHIYE_STOP_NO_PAUSE:'1'};
    await assert.rejects(run('/bin/zsh',[command],{env,timeout:5000}),e=>e.code===1&&/不是拾页服务/.test(e.stdout));
    app='chapter-downloader';await assert.rejects(run('/bin/zsh',[command],{env,timeout:5000}),e=>e.code===1&&/版本不支持/.test(e.stdout));assert.equal(posts,0);
  }finally{s.closeAllConnections();await new Promise(r=>s.close(r));}
});
