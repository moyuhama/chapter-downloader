#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { helperHome } from '../service-state.js';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version=JSON.parse(await fs.readFile(path.join(app,'package.json'),'utf8')).version;
const home = helperHome();
const port = Number(process.env.PORT || 3789);
const base = `http://127.0.0.1:${port}`;
const delay = ms => new Promise(r => setTimeout(r,ms));
async function health() {
  try { const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1200)}); const v=await r.json();return r.ok&&v.app==='chapter-downloader'?v:null; } catch {return null;}
}
function alive(pid) {try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
async function start() {
  let state=await health();if(state?.state!=='stopping'&&state){
    if(state.version===version){console.log(JSON.stringify({...state,reused:true}));return;}
    await stop();state=null;
  }
  await fs.mkdir(path.join(home,'data'),{recursive:true,mode:0o700});
  const lock=path.join(home,`start-${port}.lock`);let handle;
  try {handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    let pid;try{pid=JSON.parse(await fs.readFile(lock,'utf8')).pid;}catch{}
    if(pid&&!alive(pid)){await fs.rm(lock,{force:true});return start();}
    for(let i=0;i<100;i++){await delay(200);state=await health();if(state&&state.state!=='stopping'){console.log(JSON.stringify({...state,reused:true}));return;}}
    throw new Error('另一个启动操作尚未完成，请稍后重试');
  }
  try {
    for(let i=0;state?.state==='stopping'&&i<150;i++){await delay(200);state=await health();}
    if(state?.state==='stopping')throw new Error('旧服务仍在停止，请稍后重试');
    const env={...process.env,SHIYE_HOME:home,PORT:String(port)};
    const browsers=path.join(app,'browsers');
    try {
      await fs.access(browsers);env.PLAYWRIGHT_BROWSERS_PATH=browsers;
      process.env.PLAYWRIGHT_BROWSERS_PATH=browsers;
      env.SHIYE_BROWSER_EXECUTABLE=createRequire(path.join(app,'package.json'))('playwright').chromium.executablePath();
    } catch {}
    const logfile=await fs.open(path.join(home,'service.log'),'a',0o600);
    const child=spawn(process.execPath,[path.join(app,'server.js')],{cwd:app,env,detached:true,stdio:['ignore',logfile.fd,logfile.fd]});
    const error=new Promise((_,reject)=>child.once('error',reject));error.catch(()=>{});child.unref();await logfile.close();
    for(let i=0;i<100;i++){
      await Promise.race([delay(200),error]);state=await health();
      if(state?.state!=='stopping'&&state){console.log(JSON.stringify(state));return;}
      if(child.exitCode!==null)break;
    }
    throw new Error(`服务启动失败，请查看 ${path.join(home,'service.log')}`);
  } finally {await handle.close();await fs.rm(lock,{force:true});}
}
async function stop() {
  const state=await health();if(!state){console.log('服务已停止');return;}
  if(!state.instanceId||!state.capabilities?.shutdown)throw new Error('当前服务版本较旧，请退出旧服务后再使用启动工具');
  const response=await fetch(base+'/api/service/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceId:state.instanceId}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error((await response.json()).error||'停止失败');
  for(let i=0;i<180;i++){await delay(200);if(!await health()){console.log('服务已停止');return;}}
  throw new Error('服务仍在清理任务，请稍后查看状态');
}
try {
  const command=process.argv[2]||'start';
  if(command==='start')await start();
  else if(command==='stop')await stop();
  else if(command==='status'){const state=await health();console.log(JSON.stringify(state||{ok:false,state:'stopped'}));}
  else throw new Error('支持的命令：start、stop、status');
}catch(e){console.error(e.message);process.exitCode=1;}
