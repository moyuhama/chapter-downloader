import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const script = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function element() {
  const classes = new Set(['hidden']);
  return { value:'', checked:false, indeterminate:false, innerHTML:'', textContent:'', disabled:false, dataset:{}, listeners:{}, remove(){},
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){ if(on??!classes.has(c))classes.add(c);else classes.delete(c); }},
    setAttribute(name,value){this[name]=value;},
    addEventListener(name,fn){ (this.listeners[name]??=[]).push(fn); },
    emit(name){ for(const fn of this.listeners[name]||[]) fn({target:this}); }, click(){ return this.onclick?.(); }
  };
}
async function app({ route = () => undefined, jobs = [], storedId } = {}) {
  const nodes=new Map(); const $=id=>{ if(!nodes.has(id))nodes.set(id,element());return nodes.get(id); };
  for(const id of ['minWidth','minHeight']) $(id).value='200'; $('generatePdf').checked=true;$('splitLongImages').checked=true;$('followPages').checked=true; $('mode').value='auto';
  const storage=new Map(storedId ? [['currentDownloadId',storedId]] : []); let interval; let clock=Date.now();const timers=[],downloads=[];const localStore=new Map();
  vm.runInNewContext(script, {
    document:{getElementById:$,querySelector:()=>element(),querySelectorAll:()=>[],activeElement:null,createElement:()=>element(),body:{append:e=>downloads.push(e)}},
    location:{hostname:'127.0.0.1',origin:'http://127.0.0.1:3789'},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setInterval:fn=>{interval=fn;}, setTimeout:(fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return timer;},clearTimeout:t=>{if(t)t.cancelled=true;},AbortSignal,URL,Date:class extends Date{static now(){return clock;}},navigator:{platform:'MacIntel',userAgent:'Macintosh'},localStorage:{getItem:k=>localStore.get(k)||null,setItem:(k,v)=>localStore.set(k,v)},
    fetch:async(url,init)=>{
      const p=new URL(url,'http://127.0.0.1:3789').pathname; const input=init?.body?JSON.parse(init.body):undefined;
      let result=await route(p,input,url);
      if(result===undefined) {
        if(p==='/api/health') result={ok:true,app:'chapter-downloader',instanceId:'test-instance',state:'ready',capabilities:{shutdown:true}};
        else if(p==='/helper-release.json'||p==='/chapter-downloader/helper-release.json') result={ready:true,version:'test',macUniversal:'https://github.com/moyuhama/chapter-downloader/releases/download/test/shiye-macos-universal.zip'};
        else if(p==='/api/download-settings') result={directory:'/user/Downloads',separator:'/'};
        else if(p==='/api/jobs') result=jobs;
        else if(p==='/api/rules') result={};
        else if(p==='/api/parse') result={title:input.url,confidence:'auto',chapters:[{title:input.url+' chapter',url:input.url+'/chapter'}]};
        else if(p==='/api/preview') result={count:1,note:'preview',images:[input.url+'/image.png']};
        else throw new Error('Unexpected request: '+p);
      }
      return {ok:true,json:async()=>result};
    }
  });
  await tick();
  return {$,storage,downloads,runTimers:async()=>{for(const t of timers.splice(0))if(!t.cancelled)t.fn();await tick();},poll:async()=>{clock+=4000;interval();await tick();},url(value){$('url').value=value;$('url').emit('input');}};
}
async function startDownload(a,url='https://first.example/book') {a.url(url);await a.$('parse').click();await a.$('download').click();}
async function parseFirst(a) { a.url('https://first.example/book'); await a.$('parse').click(); await a.$('preview').click(); assert.match(a.$('previewResult').innerHTML,/first\.example/); }

test('switching source clears title, chapters, preview and completed download; polling does not restore them',async()=>{
  const job={id:'old',status:'completed',title:'OLD JOB',done:1,total:1,failed:0,message:'done',output:'/test',chapters:[{status:'completed',number:1,title:'old',imageCount:1}]};
  const a=await app({jobs:[job],storedId:'old',route:(p,b)=>p==='/api/jobs'&&b?job:undefined});
  assert.equal(a.$('jobs').innerHTML,'');await startDownload(a);
  assert.match(a.$('jobs').innerHTML,/OLD JOB/);
  a.url('https://second.example/book');
  assert.equal(a.$('jobs').innerHTML,'');assert.equal(a.storage.has('currentDownloadId'),false);
  await a.poll();assert.equal(a.$('downloadPanel').classList.contains('hidden'),true);
  await a.$('parse').click();await a.$('preview').click();
  a.url('https://third.example/book');
  assert.equal(a.$('bookTitle').value,'');assert.equal(a.$('chapterList').innerHTML,'');assert.equal(a.$('previewResult').innerHTML,'');
  assert.equal(a.$('chaptersPanel').classList.contains('hidden'),true);
  await a.$('parse').click();assert.match(a.$('chapterList').innerHTML,/third\.example/);assert.doesNotMatch(a.$('chapterList').innerHTML,/second\.example/);
});
test('reparsing the same source clears preview before the request finishes, including when parsing fails',async()=>{
  let fail=false;
  const a=await app({route:p=>{if(p==='/api/parse'&&fail)throw new Error('parse failed');}});
  await parseFirst(a); fail=true;
  await a.$('parse').click();
  assert.equal(a.$('previewResult').innerHTML,'');assert.equal(a.$('bookTitle').value,'');
  assert.equal(a.$('chaptersPanel').classList.contains('hidden'),true);assert.match(a.$('notice').textContent,/parse failed/);
});
test('a late catalog response cannot repopulate a different source',async()=>{
  const pending=deferred();
  const a=await app({route:p=>p==='/api/parse'?pending.promise:undefined});
  a.url('https://first.example/book');const operation=a.$('parse').click();await tick();
  a.url('https://second.example/book');
  pending.resolve({title:'OLD TITLE',chapters:[{title:'OLD CHAPTER',url:'https://first.example/chapter'}]});await operation;
  assert.equal(a.$('chapterList').innerHTML,'');assert.equal(a.$('bookTitle').value,'');assert.equal(a.$('chaptersPanel').classList.contains('hidden'),true);
});
test('late preview and stale rules from another source are ignored',async()=>{
  const pendingPreview=deferred(),pendingRules=deferred();let waitRules=false;
  const a=await app({route:(p,b,url)=>{
    if(p==='/api/preview')return pendingPreview.promise;
    if(p==='/api/rules'&&waitRules&&url.includes('first.example'))return pendingRules.promise;
  }});
  a.url('https://first.example/book');await a.$('parse').click();
  const preview=a.$('preview').click();await tick();a.url('https://second.example/book');
  pendingPreview.resolve({count:1,images:['https://first.example/old.png'],note:'old'});await preview;
  assert.equal(a.$('previewResult').innerHTML,'');
  waitRules=true;a.url('https://first.example/book');a.$('url').emit('blur');await tick();
  a.url('https://second.example/book');await a.$('parse').click();
  pendingRules.resolve({imageSelector:'.OLD-SELECTOR'});await tick();
  assert.equal(a.$('imageSelector').value,'');assert.match(a.$('bookTitle').value,/second\.example/);
});
test('changing source removes active downloads from the list while offering a separate background stop control',async()=>{
  const a=await app();await parseFirst(a);
  a.$('chapterList').onchange({target:{dataset:{index:'0'},checked:false}});
  assert.equal(a.$('previewResult').innerHTML,'');
  const job={id:'active',status:'running',title:'RUNNING',done:0,total:1,failed:0,message:'running',output:'/test',chapters:[]};
  let stopped=false;const b=await app({jobs:[job],storedId:'active',route:(p,body)=>{if(p==='/api/jobs'&&body)return job;if(p==='/api/jobs/active/stop'){stopped=true;job.status='stopped';return job;}}});
  await startDownload(b);assert.match(b.$('jobs').innerHTML,/data-action="stop"/);
  b.url('https://second.example/book');assert.equal(b.$('jobs').innerHTML,'');await b.poll();
  assert.equal(b.$('downloadPanel').classList.contains('hidden'),true);assert.equal(b.$('backgroundDownload').classList.contains('hidden'),false);assert.equal(stopped,false);
  await b.$('stopBackgroundDownload').click();assert.equal(stopped,true);assert.equal(b.$('backgroundDownload').classList.contains('hidden'),true);
});
test('in-flight polling cannot revive old jobs and background completion does not repopulate the list',async()=>{
  const job={id:'old',status:'completed',title:'OLD JOB',done:1,total:1,failed:0,message:'done',output:'/test',chapters:[]};
  let delayed=false;const pending=deferred();
  const a=await app({jobs:[job],storedId:'old',route:(p,b)=>p==='/api/jobs'?(b?job:delayed?pending.promise:undefined):undefined});
  await startDownload(a);delayed=true;const polling=a.poll();await tick();a.url('https://second.example/book');pending.resolve([job]);await polling;
  assert.equal(a.$('jobs').innerHTML,'');assert.equal(a.$('downloadPanel').classList.contains('hidden'),true);
  job.status='running';const b=await app({jobs:[job],storedId:'old',route:(p,body)=>p==='/api/jobs'&&body?job:undefined});await startDownload(b);b.url('https://second.example/book');await b.poll();
  assert.equal(b.$('jobs').innerHTML,'');assert.equal(b.$('backgroundDownload').classList.contains('hidden'),false);job.status='completed';await b.poll();
  assert.equal(b.$('backgroundDownload').classList.contains('hidden'),true);
  assert.equal(b.$('jobs').innerHTML,'');assert.equal(b.$('downloadPanel').classList.contains('hidden'),true);
});
test('prefills default destination, allows choosing a folder and locks the final name when download starts',async()=>{
  const pending=deferred();let payload,created;
  const a=await app({route:(p,b)=>{
    if(p==='/api/choose-directory')return {directory:'/custom/folder'};
    if(p==='/api/jobs'&&b){payload=b;return pending.promise;}
    if(p==='/api/jobs')return created?[created]:[];
  }});
  assert.equal(a.$('downloadDirectory').value,'/user/Downloads');
  a.url('https://example.com/book');await a.$('parse').click();
  assert.equal(a.$('bookTitle').readOnly,false);
  await a.$('chooseDirectory').click();assert.equal(a.$('downloadDirectory').value,'/custom/folder');
  a.$('bookTitle').value='自定义名称';
  const downloading=a.$('download').click();await tick();
  assert.equal(a.$('bookTitle').readOnly,true);assert.equal(a.$('downloadDirectory').readOnly,true);
  assert.equal(payload.title,'自定义名称');assert.equal(payload.directory,'/custom/folder');
  created={id:'new',title:'自定义名称',folderName:'自定义名称 (2)',directory:'/custom/folder',output:'/custom/folder/自定义名称 (2)',status:'running',chapters:[],done:0,total:0,failed:0,message:'running'};
  pending.resolve(created);await downloading;
  assert.equal(a.$('bookTitle').value,'自定义名称 (2)');assert.equal(a.$('bookTitle').readOnly,true);
  assert.equal(a.$('chooseDirectory').disabled,true);assert.match(a.$('outputHint').textContent,/已锁定/);
  a.url('https://next.example/book');await a.$('parse').click();assert.equal(a.$('bookTitle').readOnly,false);
});
test('a failed start unlocks name and destination for correction',async()=>{
  const a=await app({route:(p,b)=>{if(p==='/api/jobs'&&b)throw new Error('目录不可写');}});
  a.url('https://example.com/book');await a.$('parse').click();await a.$('download').click();
  assert.equal(a.$('bookTitle').readOnly,false);assert.equal(a.$('downloadDirectory').readOnly,false);
  assert.equal(a.$('chooseDirectory').disabled,false);assert.match(a.$('notice').textContent,/目录不可写/);
});
test('sends the selected chapter concurrency and locks it together with the destination',async()=>{
  let payload;
  const a=await app({route:(p,b)=>{if(p==='/api/jobs'&&b){payload=b;return {id:'parallel',status:'running',title:b.title,directory:b.directory,folderName:b.title,output:'/target',chapterConcurrency:b.chapterConcurrency};}}});
  a.url('https://example.com/book');await a.$('parse').click();a.$('chapterConcurrency').value='4';await a.$('download').click();
  assert.equal(payload.chapterConcurrency,4);assert.equal(a.$('chapterConcurrency').disabled,true);
  a.url('https://next.example/book');assert.equal(a.$('chapterConcurrency').disabled,false);
});
test('PDF defaults are submitted, conversion options lock after starting, and disabling PDF disables long-image splitting',async()=>{
  let payload;
  const a=await app({route:(p,b)=>{if(p==='/api/jobs'&&b){payload=b;return {id:'pdf',status:'running',title:b.title,directory:b.directory,folderName:b.title,output:'/target'};}}});
  a.url('https://example.com/book');await a.$('parse').click();await a.$('download').click();
  assert.equal(payload.generatePdf,true);assert.equal(payload.splitLongImages,true);assert.equal(a.$('generatePdf').disabled,true);assert.equal(a.$('splitLongImages').disabled,true);
  a.url('https://next.example/book');a.$('generatePdf').checked=false;a.$('generatePdf').emit('change');assert.equal(a.$('splitLongImages').disabled,true);
});
test('PDF failure and completed chapter links render separately from image download status',async()=>{
  const job={id:'pdfjob',status:'partial',title:'PDF',generatePdf:true,done:4,total:4,failed:0,message:'partial',output:'/test',chapters:[
    {number:1,title:'chapter1',status:'completed',imageCount:2,pdf:{status:'failed',error:'bad <tag>'}},
    {number:2,title:'chapter2',status:'completed',imageCount:2,pdf:{status:'completed',file:'chapter2.pdf',pages:2}},
  ]};
  const a=await app({jobs:[job],storedId:'pdfjob',route:(p,b)=>p==='/api/jobs'&&b?job:undefined});await startDownload(a);const html=a.$('jobs').innerHTML;
  assert.match(html,/data-action="retry-pdf"/);assert.match(html,/bad &lt;tag&gt;/);assert.match(html,/\/api\/jobs\/pdfjob\/chapters\/2\/pdf/);assert.match(html,/2 页/);
});
test('local PDF tool works without parsing a URL, preserves chosen order and clears old results when source changes',async()=>{
  let payload,task;
  const a=await app({route:(p,b)=>{
    if(p==='/api/local-images')return {directory:b.source,name:'本地章节',files:[{name:'1.png'},{name:'2.png'},{name:'10.png'}]};
    if(p==='/api/conversions'){payload=b;task={id:'local',name:'自定义.pdf',status:'generating',done:0,total:b.files.length,pages:0,output:'/out/自定义.pdf'};return task;}
    if(p==='/api/conversions/local')return task;
  }});
  a.$('showLocalPdf').click();assert.equal(a.$('collectorTool').classList.contains('hidden'),true);
  assert.equal(a.$('localPdfDirectory').value,'/user/Downloads');
  a.$('localPdfSource').value='/images';await a.$('localPdfScan').click();assert.equal(a.$('localPdfName').value,'本地章节');
  a.$('localPdfReverse').click();a.$('localPdfName').value='自定义';await a.$('localPdfStart').click();
  assert.deepEqual(payload.files,['10.png','2.png','1.png']);assert.equal(payload.source,'/images');assert.equal(a.$('localPdfSource').readOnly,true);
  task={...task,status:'completed',done:3,pages:3};await a.poll();assert.match(a.$('localPdfResult').innerHTML,/打开 PDF/);assert.equal(a.$('localPdfSource').readOnly,false);
  a.$('localPdfSource').value='/new-images';a.$('localPdfSource').emit('input');assert.equal(a.$('localPdfResult').innerHTML,'');assert.equal(a.$('localPdfSettings').classList.contains('hidden'),true);
});
test('local folder scan failures are shown and do not leave a stale image list',async()=>{
  const a=await app({route:p=>{if(p==='/api/local-images')throw new Error('没有支持的图片');}});
  a.$('localPdfSource').value='/empty';await a.$('localPdfScan').click();assert.match(a.$('localPdfNotice').textContent,/没有支持/);assert.equal(a.$('localPdfSettings').classList.contains('hidden'),true);
});
test('startup shows installation guidance, triggers first-time download and automatically connects when service appears',async()=>{
  let online=false;
  const a=await app({route:p=>{if(p==='/api/health'&&!online)throw new Error('offline');}});
  await a.$('connectBackend').click();assert.equal(a.$('helperGuide').classList.contains('hidden'),false);
  await a.runTimers();assert.equal(a.downloads.length,1);assert.match(a.downloads[0].href,/shiye-macos-universal\.zip$/);assert.match(a.$('helperDownloadState').textContent,/已发起下载/);
  online=true;await a.poll();assert.equal(a.$('backendState').textContent,'已连接');assert.equal(a.$('helperGuide').classList.contains('hidden'),true);assert.equal(a.$('disconnectBackend').disabled,false);
});
test('disconnect uses the connected instance and does not restart or redownload after stop',async()=>{
  let online=true,payload;
  const a=await app({route:(p,b)=>{if(p==='/api/health'&&!online)throw new Error('offline');if(p==='/api/service/stop'){payload=b;online=false;return {ok:true,state:'stopping'};}}});
  await a.$('connectBackend').click();await a.$('disconnectBackend').click();await a.poll();await a.runTimers();
  assert.equal(payload.instanceId,'test-instance');assert.equal(a.$('backendState').textContent,'已停止');assert.equal(a.downloads.length,0);
});
test('manually opened install instructions remain visible while an existing service is connected',async()=>{
  const a=await app();await a.$('connectBackend').click();a.$('showHelperGuide').click();await a.poll();
  assert.equal(a.$('helperGuide').classList.contains('hidden'),false);assert.equal(a.$('backendState').textContent,'已连接');
});
function downloadJob(id,status='completed',url='https://first.example/book'){return {id,status,url,title:`JOB-${id}`,done:1,total:1,failed:0,message:status,output:'/test',chapters:[]};}
test('opening or reconnecting the page never restores previous lists from session IDs or backend history',async()=>{
  for(const status of ['queued','running','paused','completed','partial','failed','stopped','interrupted']){
    const old=downloadJob('legacy',status);const a=await app({jobs:[old],storedId:old.id});
    await a.poll();await a.$('connectBackend').click();
    assert.equal(a.$('jobs').innerHTML,'',status);assert.equal(a.$('downloadPanel').classList.contains('hidden'),true,status);assert.equal(a.storage.has('currentDownloadId'),false);
    assert.equal(a.$('backgroundDownload').classList.contains('hidden'),!['queued','running','paused'].includes(status));
  }
});
test('a new website download shows only its own job while old completed records remain on the backend',async()=>{
  const old=downloadJob('old'),fresh=downloadJob('fresh','running','https://second.example/book');const records=[old,fresh];
  const a=await app({jobs:records,route:(p,b)=>p==='/api/jobs'&&b?(b.url===old.url?old:fresh):undefined});
  await startDownload(a,old.url);assert.match(a.$('jobs').innerHTML,/JOB-old/);
  a.url(fresh.url);assert.equal(a.$('jobs').innerHTML,'');await startDownload(a,fresh.url);await a.poll();
  assert.match(a.$('jobs').innerHTML,/JOB-fresh/);assert.doesNotMatch(a.$('jobs').innerHTML,/JOB-old/);
});
test('a late download-creation response for the previous source cannot bind its list to the new source',async()=>{
  const pending=deferred(),old=downloadJob('late','running');let created=false;
  const a=await app({route:(p,b)=>{if(p==='/api/jobs'&&b)return pending.promise;if(p==='/api/jobs')return created?[old]:[];}});
  a.url(old.url);await a.$('parse').click();const starting=a.$('download').click();await tick();
  a.url('https://second.example/book');created=true;pending.resolve(old);await starting;await a.poll();
  assert.equal(a.$('jobs').innerHTML,'');assert.equal(a.$('downloadPanel').classList.contains('hidden'),true);assert.equal(a.$('backgroundDownload').classList.contains('hidden'),false);assert.equal(a.$('bookTitle').readOnly,false);
});
test('browser autofill without input events still clears the previous source on the next refresh',async()=>{
  const old=downloadJob('autofill');const a=await app({jobs:[old],route:(p,b)=>p==='/api/jobs'&&b?old:undefined});
  await startDownload(a,old.url);assert.match(a.$('jobs').innerHTML,/JOB-autofill/);
  a.$('url').value='https://new.example/book';await a.poll();
  assert.equal(a.$('jobs').innerHTML,'');assert.equal(a.$('chapterList').innerHTML,'');assert.equal(a.$('bookTitle').value,'');
});
test('normalization by the backend does not hide the current task for a URL without a trailing slash',async()=>{
  const job=downloadJob('normalized','running','https://first.example/');const a=await app({jobs:[job],route:(p,b)=>p==='/api/jobs'&&b?job:undefined});
  await startDownload(a,'https://first.example');assert.match(a.$('jobs').innerHTML,/JOB-normalized/);
});
