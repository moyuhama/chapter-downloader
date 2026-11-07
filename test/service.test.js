import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
