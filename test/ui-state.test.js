import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const script = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function element() {
  const classes = new Set(['hidden']);
  return { value:'', checked:false, indeterminate:false, innerHTML:'', textContent:'', disabled:false, dataset:{}, listeners:{},
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){ if(on??!classes.has(c))classes.add(c);else classes.delete(c); }},
    addEventListener(name,fn){ (this.listeners[name]??=[]).push(fn); },
    emit(name){ for(const fn of this.listeners[name]||[]) fn({target:this}); }, click(){ return this.onclick?.(); }
  };
}
async function app({ route = () => undefined, jobs = [], storedId } = {}) {
  const nodes=new Map(); const $=id=>{ if(!nodes.has(id))nodes.set(id,element());return nodes.get(id); };
  for(const id of ['minWidth','minHeight']) $(id).value='200'; $('generatePdf').checked=true;$('splitLongImages').checked=true;$('followPages').checked=true; $('mode').value='auto';
  const storage=new Map(storedId ? [['currentDownloadId',storedId]] : []); let interval;
  vm.runInNewContext(script, {
    document:{getElementById:$,querySelector:()=>element(),querySelectorAll:()=>[],activeElement:null},
    location:{hostname:'127.0.0.1',origin:'http://127.0.0.1:3789'},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setInterval:fn=>{interval=fn;}, AbortSignal,
    fetch:async(url,init)=>{
      const p=new URL(url).pathname; const input=init?.body?JSON.parse(init.body):undefined;
      let result=await route(p,input,url);
      if(result===undefined) {
        if(p==='/api/download-settings') result={directory:'/user/Downloads',separator:'/'};
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
  return {$,storage,poll:async()=>{interval();await tick();},url(value){$('url').value=value;$('url').emit('input');}};
}
async function parseFirst(a) { a.url('https://first.example/book'); await a.$('parse').click(); await a.$('preview').click(); assert.match(a.$('previewResult').innerHTML,/first\.example/); }

test('switching source clears title, chapters, preview and completed download; polling does not restore them',async()=>{
  const job={id:'old',status:'completed',title:'OLD JOB',done:1,total:1,failed:0,message:'done',output:'/test',chapters:[{status:'completed',number:1,title:'old',imageCount:1}]};
  const a=await app({jobs:[job],storedId:'old'});
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
test('changing chapter selection clears preview and active downloads remain controllable',async()=>{
  const a=await app();await parseFirst(a);
  a.$('chapterList').onchange({target:{dataset:{index:'0'},checked:false}});
  assert.equal(a.$('previewResult').innerHTML,'');
  const job={id:'active',status:'running',title:'RUNNING',done:0,total:1,failed:0,message:'running',output:'/test',chapters:[]};
  const b=await app({jobs:[job],storedId:'active'});b.url('https://second.example/book');await b.poll();
  assert.match(b.$('jobs').innerHTML,/data-action="stop"/);
});
test('in-flight polling cannot revive old jobs, and a detached active job disappears once finished',async()=>{
  const job={id:'old',status:'completed',title:'OLD JOB',done:1,total:1,failed:0,message:'done',output:'/test',chapters:[]};
  let delayed=false;const pending=deferred();
  const a=await app({jobs:[job],storedId:'old',route:p=>p==='/api/jobs'&&delayed?pending.promise:undefined});
  delayed=true;const polling=a.poll();await tick();a.url('https://second.example/book');pending.resolve([job]);await polling;
  assert.equal(a.$('jobs').innerHTML,'');assert.equal(a.$('downloadPanel').classList.contains('hidden'),true);
  job.status='running';const b=await app({jobs:[job],storedId:'old'});b.url('https://second.example/book');await b.poll();
  assert.match(b.$('jobs').innerHTML,/OLD JOB/);job.status='completed';await b.poll();
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
  const a=await app({jobs:[job],storedId:'pdfjob'});const html=a.$('jobs').innerHTML;
  assert.match(html,/data-action="retry-pdf"/);assert.match(html,/bad &lt;tag&gt;/);assert.match(html,/\/api\/jobs\/pdfjob\/chapters\/2\/pdf/);assert.match(html,/2 页/);
});
