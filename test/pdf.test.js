import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { generateChapterPdf } from '../pdf.js';
import { Jobs } from '../jobs.js';
import { sleep } from '../crawler.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn){const deadline=Date.now()+10000;while(!fn()){if(Date.now()>deadline)throw new Error('Timed out');await sleep(10);}}
async function image(width,height,color='red',format='png'){return sharp({create:{width,height,channels:3,background:color}}).toFormat(format).toBuffer();}
function pageSizes(buffer){return [...buffer.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m=>[Number(m[1]),Number(m[2])]);}
async function temporary(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chapter-pdf-'));try{return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
const entry=(index,file)=>({index,file,status:'done'});

test('PDF pages follow manifest order and use the image aspect ratios across PNG, JPEG and WebP',()=>temporary(async dir=>{
  const formats=['png','jpeg','webp'];
  for(let i=0;i<3;i++)await fs.writeFile(path.join(dir,`${i+1}.${formats[i]}`),await image(100,140+i*40,['red','green','blue'][i],formats[i]));
  const output=path.join(dir,'chapter.pdf'),progress=[];
  const result=await generateChapterPdf({directory:dir,output,title:'顺序测试',images:[entry(3,'3.webp'),entry(1,'1.png'),entry(2,'2.jpeg')],onProgress:async p=>progress.push(p.done)});
  const pdf=await fs.readFile(output);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(pdf.toString('latin1'),/%%EOF/);
  assert.deepEqual(pageSizes(pdf),[[600,840],[600,1080],[600,1320]]);assert.equal(result.pages,3);assert.deepEqual(progress,[1,2,3]);
}));
test('long images split into contiguous pages, with optional original full-height pages',()=>temporary(async dir=>{
  await fs.writeFile(path.join(dir,'long.png'),await image(100,500));
  const args={directory:dir,title:'长图',images:[entry(1,'long.png')]};
  await generateChapterPdf({...args,output:path.join(dir,'split.pdf')});
  assert.deepEqual(pageSizes(await fs.readFile(path.join(dir,'split.pdf'))),[[600,900],[600,900],[600,900],[600,300]]);
  await generateChapterPdf({...args,output:path.join(dir,'whole.pdf'),splitLongImages:false});
  assert.deepEqual(pageSizes(await fs.readFile(path.join(dir,'whole.pdf'))),[[600,3000]]);
}));
test('SVG, AVIF and JPEG orientation are handled without changing original files',()=>temporary(async dir=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="orange"/></svg>');
  await fs.writeFile(path.join(dir,'1.svg'),svg);
  await fs.writeFile(path.join(dir,'2.avif'),await image(100,200,'blue','avif'));
  const jpeg=await sharp(await image(100,200,'green','jpeg')).withMetadata({orientation:6}).toBuffer();await fs.writeFile(path.join(dir,'3.jpg'),jpeg);
  await generateChapterPdf({directory:dir,output:path.join(dir,'chapter.pdf'),title:'格式测试',images:[entry(1,'1.svg'),entry(2,'2.avif'),entry(3,'3.jpg')]});
  assert.deepEqual(pageSizes(await fs.readFile(path.join(dir,'chapter.pdf'))),[[600,900],[600,1200],[600,300]]);assert.deepEqual(await fs.readFile(path.join(dir,'1.svg')),svg);assert.deepEqual(await fs.readFile(path.join(dir,'3.jpg')),jpeg);
}));
test('incomplete, corrupted and stopped generation never leaves a finished PDF or temporary parts',()=>temporary(async dir=>{
  await fs.writeFile(path.join(dir,'1.png'),await image(100,150));await fs.writeFile(path.join(dir,'bad.png'),'bad');
  const args={directory:dir,output:path.join(dir,'chapter.pdf'),title:'cleanup'};
  await assert.rejects(generateChapterPdf({...args,images:[{...entry(1,'1.png'),status:'failed'}]}),/全部下载/);
  await assert.rejects(generateChapterPdf({...args,images:[entry(1,'1.png'),entry(2,'bad.png')]}));
  let stop=false;await assert.rejects(generateChapterPdf({...args,images:[entry(1,'1.png'),entry(2,'1.png')],checkpoint:async()=>{if(stop)throw new Error('__STOP__');},onProgress:async()=>{stop=true;}}),/__STOP__/);
  assert.deepEqual((await fs.readdir(dir)).sort(),['1.png','bad.png']);
}));

async function setup(root,{pdfBuilder=generateChapterPdf,chapterError=false}={}){
  const png=await image(100,150);const calls={chapters:0,images:0};
  const crawler={chapter:async url=>{calls.chapters++;if(chapterError)throw new Error('chapter failed');return [1,2].map(i=>({url:url+`/${i}.png`,pageUrl:url}));},bytes:async()=>{calls.images++;return {type:'image/png',body:png};}};
  const jobs=new Jobs(root,crawler,{defaultDirectory:path.join(root,'Downloads'),pdfBuilder});await jobs.init();return {jobs,calls};
}
const input=n=>({url:'https://example.com/book',title:'PDF测试',chapters:Array.from({length:n},(_,i)=>({title:`第${i+1}章`,url:`https://example.com/ch/${i+1}`}))});

test('PDF generation is serialized while other chapters keep downloading, and completion waits for PDFs',()=>temporary(async root=>{
  const first=gate();let active=0,peak=0,generated=0;
  const {jobs,calls}=await setup(root,{pdfBuilder:async args=>{active++;peak=Math.max(peak,active);try{if(generated++===0)await first.promise;return await generateChapterPdf(args);}finally{active--;}}});
  try{
    const created=await jobs.create(input(4));const job=jobs.jobs.get(created.id);assert.equal(job.generatePdf,true);
    await until(()=>job.chapters.every(c=>c.status==='completed'));assert.equal(job.status,'running');assert.equal(calls.images,8);assert.equal(job.chapters.filter(c=>c.pdf?.status==='generating').length,1);
    first.resolve();await until(()=>!jobs.running.has(job.id));assert.equal(job.status,'completed');assert.equal(peak,1);
    for(const c of job.chapters){assert.equal(c.pdf.status,'completed');assert.equal(c.pdf.pages,2);assert.equal(pageSizes(await fs.readFile(path.join(job.output,c.folder,c.pdf.file))).length,2);}
  }finally{first.resolve();await until(()=>jobs.running.size===0);}
}));
test('PDF-only retry does not download images again; missing chapters do not get incomplete PDFs',()=>temporary(async root=>{
  let fail=true;const {jobs,calls}=await setup(root,{pdfBuilder:args=>{if(fail)throw new Error('PDF failed');return generateChapterPdf(args);}});
  const created=await jobs.create(input(1)),job=jobs.jobs.get(created.id);await until(()=>!jobs.running.has(job.id));
  assert.equal(job.status,'partial');assert.equal(job.chapters[0].status,'completed');assert.equal(job.chapters[0].pdf.status,'failed');
  fail=false;await jobs.control(job.id,'retry-pdf');await until(()=>!jobs.running.has(job.id));assert.equal(job.status,'completed');assert.equal(calls.images,2);assert.equal(calls.chapters,1);
  const missing=await setup(path.join(root,'missing'),{chapterError:true,pdfBuilder:()=>{throw new Error('must not run');}});
  const failed=await missing.jobs.create(input(1));await until(()=>!missing.jobs.running.has(failed.id));assert.equal(missing.jobs.jobs.get(failed.id).chapters[0].pdf,undefined);
}));
test('stopping PDF work cleans temporary output and can resume without downloading again',()=>temporary(async root=>{
  const wait=gate();let started=false;
  const {jobs,calls}=await setup(root,{pdfBuilder:async args=>{started=true;await wait.promise;return generateChapterPdf(args);}});
  try{
    const created=await jobs.create(input(1)),job=jobs.jobs.get(created.id);await until(()=>started);await jobs.control(job.id,'stop');wait.resolve();await until(()=>!jobs.running.has(job.id));
    assert.equal(job.status,'stopped');assert.equal(job.chapters[0].pdf.status,'pending');
    assert.ok(!(await fs.readdir(path.join(job.output,job.chapters[0].folder))).some(f=>f.endsWith('.part')||f.endsWith('.pdf')));
    await jobs.control(job.id,'resume');await until(()=>!jobs.running.has(job.id));assert.equal(job.status,'completed');assert.equal(calls.images,2);
  }finally{wait.resolve();await until(()=>jobs.running.size===0);}
}));
