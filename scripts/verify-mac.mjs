import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const run=promisify(execFile),bundle=path.resolve(process.argv[2]);
const check=JSON.parse((await run(path.join(bundle,'Contents/MacOS/ShiyeHelper'),['--check'])).stdout);assert.ok(check.node&&check.cli);
for(const url of ['shiye://start','shiye://start/'])await run(path.join(bundle,'Contents/MacOS/ShiyeHelper'),['--validate-url',url]);
for(const url of ['shiye://install','shiye://start?cmd=anything','shiye://user@start','https://start'])await assert.rejects(run(path.join(bundle,'Contents/MacOS/ShiyeHelper'),['--validate-url',url]));
let resources=path.join(bundle,'Contents/Resources');try{await fs.access(path.join(resources,'node'));}catch{resources=path.join(resources,process.arch);}
const node=path.join(resources,'node'),app=path.join(resources,'app'),cli=path.join(app,'launcher/cli.mjs');
const home=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-bundle-'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const env={...process.env,SHIYE_HOME:home,PORT:String(port),CRAWLER_HEADLESS:'1'};
try {
  const started=JSON.parse((await run(node,[cli,'start'],{env,timeout:25000})).stdout);assert.equal(started.state,'ready');
  const response=await fetch(`http://127.0.0.1:${port}/api/health`);assert.equal(response.status,200);
  const source=path.join(home,'images');await fs.mkdir(source);
  const sharp=createRequire(path.join(app,'package.json'))('sharp');
  await sharp({create:{width:200,height:300,channels:3,background:'#88aa66'}}).png().toFile(path.join(source,'001.png'));
  const conversion=await (await fetch(`http://127.0.0.1:${port}/api/conversions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,directory:path.join(home,'out'),files:['001.png'],name:'bundle-test'})})).json();
  let status;for(let i=0;i<100;i++){status=await (await fetch(`http://127.0.0.1:${port}/api/conversions/${conversion.id}`)).json();if(status.status==='completed'||status.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(status.status,'completed');assert.equal(status.pages,1);
  assert.equal(started.capabilities.reader,true);
  const opened=await (await fetch(`http://127.0.0.1:${port}/api/reader/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source})})).json();
  assert.equal(opened.total,1);assert.equal(opened.chapters.length,1);
  const page=await fetch(`http://127.0.0.1:${port}/reader.html`);assert.equal(page.status,200);
  const image=await fetch(`http://127.0.0.1:${port}/api/reader/image/0/0?book=${opened.id}`);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  await image.arrayBuffer();
  process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(app,'browsers');
  const {chromium}=createRequire(path.join(app,'package.json'))('playwright');await fs.access(chromium.executablePath());
  const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});await browser.close();
  await run(node,[cli,'stop'],{env,timeout:10000});
  console.log(JSON.stringify({arch:process.arch,check,service:'start/stop passed',pdf:'passed',reader:'passed',bundledBrowser:'passed',protocolValidation:'passed'}));
}finally{await run(node,[cli,'stop'],{env,timeout:10000}).catch(()=>{});await fs.rm(home,{recursive:true,force:true});}
