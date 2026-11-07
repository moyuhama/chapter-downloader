import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { LocalPdf, scanImageDirectory } from '../local-pdf.js';
import { PdfQueue } from '../pdf-queue.js';
import { sleep } from '../crawler.js';
async function until(fn){const deadline=Date.now()+5000;while(!fn()){if(Date.now()>deadline)throw new Error('Timed out');await sleep(10);}}
async function fixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-pdf-'));try{const source=path.join(root,'图片章节');await fs.mkdir(source);for(const [name,height]of[['10.png',200],['2.png',150],['1.png',100]])await sharp({create:{width:100,height,channels:3,background:'green'}}).png().toFile(path.join(source,name));await fs.writeFile(path.join(source,'manifest.json'),'{}');return await fn({root,source,directory:path.join(root,'Downloads')});}finally{await fs.rm(root,{recursive:true,force:true});}}
function sizes(pdf){return [...pdf.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m=>Number(m[2]));}

test('scanning filters non-images, uses natural ordering and rejects empty folders or relative paths',()=>fixture(async({root,source})=>{
  const result=await scanImageDirectory(source);assert.deepEqual(result.files.map(f=>f.name),['1.png','2.png','10.png']);assert.equal(result.name,'图片章节');
  await assert.rejects(scanImageDirectory('relative'),/完整/);const empty=path.join(root,'empty');await fs.mkdir(empty);await assert.rejects(scanImageDirectory(empty),/没有支持/);
}));
test('standalone conversion preserves selected order and originals, uses defaults and never overwrites existing PDFs',()=>fixture(async({source,directory})=>{
  const converter=new LocalPdf({defaultDirectory:directory});const original=await fs.readFile(path.join(source,'2.png'));
  const created=await converter.create({source,name:'阅读顺序',files:['10.png','2.png']});await until(()=>!converter.busy);
  const task=converter.get(created.id);assert.equal(task.status,'completed');assert.equal(task.pages,2);assert.deepEqual(sizes(await fs.readFile(task.output)),[1200,900]);assert.deepEqual(await fs.readFile(path.join(source,'2.png')),original);
  const first=await fs.readFile(task.output);const second=await converter.create({source,name:'阅读顺序.pdf',files:['1.png']});await until(()=>!converter.busy);assert.ok(second.output.endsWith('阅读顺序 (2).pdf'));assert.deepEqual(await fs.readFile(task.output),first);
}));
test('rejects duplicate names, traversal and symlinks before reading files',()=>fixture(async({root,source,directory})=>{
  const converter=new LocalPdf();for(const files of [[],['1.png','1.png'],['../1.png'],['manifest.json']])await assert.rejects(converter.create({source,directory,files}),/请选择/);
  await fs.symlink(path.join(source,'1.png'),path.join(source,'linked.png'));await assert.rejects(converter.create({source,directory,files:['linked.png']}),/普通文件/);
  assert.equal((await scanImageDirectory(source)).files.length,3);
}));
test('conversion shares the serial PDF queue and queued work can be cancelled without producing output',()=>fixture(async({source,directory})=>{
  const queue=new PdfQueue();let release;const hold=queue.run(()=>new Promise(r=>release=r));await until(()=>!!release);
  const converter=new LocalPdf({pdfQueue:queue});const task=await converter.create({source,directory,files:['1.png']});assert.equal(task.status,'queued');
  await assert.rejects(converter.create({source,directory,files:['1.png']}),/等待当前转换/);converter.stop(task.id);release();await hold;await until(()=>!converter.busy);
  assert.equal(converter.get(task.id).status,'stopped');assert.deepEqual(await fs.readdir(directory),[]);
}));
test('corrupt input fails cleanly and allows another conversion',()=>fixture(async({source,directory})=>{
  await fs.writeFile(path.join(source,'broken.png'),'bad');const converter=new LocalPdf();const task=await converter.create({source,directory,files:['1.png','broken.png']});await until(()=>!converter.busy);
  assert.equal(converter.get(task.id).status,'failed');assert.deepEqual(await fs.readdir(directory),[]);
  const retry=await converter.create({source,directory,files:['1.png']});await until(()=>!converter.busy);assert.equal(converter.get(retry.id).status,'completed');
}));
test('exclusive PDF publication cannot overwrite a file created during conversion',()=>fixture(async({source,directory})=>{
  await fs.mkdir(directory);let inserted=false;
  const {generateChapterPdf}=await import('../pdf.js');
  const converter=new LocalPdf({pdfBuilder:async args=>generateChapterPdf({...args,onProgress:async p=>{await args.onProgress(p);if(!inserted){inserted=true;await fs.writeFile(args.output,'existing');}}})});
  const task=await converter.create({source,directory,files:['1.png']});await until(()=>!converter.busy);
  assert.equal(converter.get(task.id).status,'failed');assert.equal(await fs.readFile(task.output,'utf8'),'existing');assert.ok(!(await fs.readdir(directory)).some(f=>f.endsWith('.part')));
}));
