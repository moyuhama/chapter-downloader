import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {Reader} from '../reader.js';
const publicDirectory=fileURLToPath(new URL('../public',import.meta.url));
async function fixture(t){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-reader-'));
  const source=path.join(temp,'我的作品');await fs.mkdir(source);
  const image=await sharp({create:{width:80,height:120,channels:3,background:'#a0bc80'}}).png().toBuffer();
  for(const title of ['第10章','第2章']){const dir=path.join(source,title);await fs.mkdir(dir);for(const name of ['10.png','2.png','1.png'])await fs.writeFile(path.join(dir,name),image);}
  const reader=new Reader({stateDirectory:path.join(temp,'state'),publicDirectory,addresses:()=>['192.168.1.99']});
  t.after(async()=>{await reader.stopShare();await fs.rm(temp,{recursive:true,force:true});});return {reader,temp,source,image};
}
function request(url,{method='GET',token,origin,host,route}={}){
  const target=new URL(url);return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:target.port,path:route||target.pathname,method,headers:{Host:host||target.host,...(origin?{Origin:origin}:{}),...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{const data=[];res.on('data',c=>data.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(data),json:()=>JSON.parse(Buffer.concat(data))}));});req.on('error',reject);req.end();
  });
}
test('reader scans chapter/image natural order, skips links and PDFs, persists only current work and keeps its stable ID',async t=>{
  const {reader,temp,source}=await fixture(t);
  await fs.writeFile(path.join(source,'第2章','book.pdf'),'not an image');await fs.symlink(path.join(source,'第2章'),path.join(source,'第1章'));
  const first=await reader.open(source);assert.deepEqual(first.chapters.map(c=>c.title),['第2章','第10章']);assert.equal(first.total,6);
  const c=await reader.chapterData(first.id,0);assert.deepEqual(c.images.map(i=>i.name),['1.png','2.png','10.png']);assert.equal(c.images[0].width,80);assert.equal(c.images[0].height,120);
  assert.equal(JSON.stringify(first).includes(source),false);
  const restored=new Reader({stateDirectory:path.join(temp,'state'),publicDirectory});await restored.init();assert.equal(restored.summary().id,first.id);
  await assert.rejects(reader.open('relative'),/完整路径/);assert.equal(reader.summary().id,first.id);
  const direct=await reader.open(path.join(source,'第10章'));assert.equal(direct.chapters.length,1);assert.notEqual(direct.id,first.id);
  await assert.rejects(reader.chapterData(first.id,0),/作品已切换/);
});
test('reader refuses changed symlink files/directories and rasterizes SVG instead of exposing active documents',async t=>{
  const {reader,temp,source,image}=await fixture(t);const first=await reader.open(source);
  await fs.unlink(path.join(source,'第2章','1.png'));await fs.writeFile(path.join(temp,'outside.png'),image);await fs.symlink(path.join(temp,'outside.png'),path.join(source,'第2章','1.png'));
  await assert.rejects(reader.imageFile(first.id,0,0));
  await fs.rename(path.join(source,'第10章'),path.join(temp,'moved'));await fs.symlink(path.join(temp,'moved'),path.join(source,'第10章'));await assert.rejects(reader.imageFile(first.id,1,0),/文件夹已变化/);
  const svg=path.join(temp,'svg');await fs.mkdir(svg);await fs.writeFile(path.join(svg,'1.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"><rect width="30" height="40" fill="red"/></svg>');
  const next=await reader.open(svg);const share=await reader.startShare();const token=new URLSearchParams(new URL(share.urls[0]).hash.slice(1)).get('share');
  const r=await request(share.urls[0],{token,route:`/api/reader/image/0/0?book=${next.id}`});assert.equal(r.status,200);assert.equal(r.headers['content-type'],'image/png');assert.equal((await sharp(r.bytes).metadata()).format,'png');
});
test('LAN reader requires a revocable token and exact host/origin, exposes no control APIs or arbitrary paths',async t=>{
  const {reader,source}=await fixture(t);const book=await reader.open(source);assert.equal(reader.shareStatus().enabled,false);
  const share=await reader.startShare();assert.equal(share.urls.length,1);assert.match(share.qr,/^data:image\/png;base64,/);
  const url=share.urls[0],token=new URLSearchParams(new URL(url).hash.slice(1)).get('share');
  assert.equal((await request(url,{route:'/reader.html'})).status,200);
  assert.equal((await request(url,{route:'/api/reader/book'})).status,401);
  assert.equal((await request(url,{token:'wrong',route:'/api/reader/book'})).status,401);
  assert.equal((await request(url,{token,origin:'https://attacker.example',route:'/api/reader/book'})).status,403);
  assert.equal((await request(url,{token,host:'attacker.example',route:'/api/reader/book'})).status,403);
  const summary=await request(url,{token,route:'/api/reader/book'});assert.equal(summary.json().id,book.id);
  for(const route of ['/api/reader/source','/api/reader/share','/api/jobs','/api/health','/api/service/stop','/server.js','/../server.js'])assert.equal((await request(url,{token,route})).status,404);
  assert.equal((await request(url,{token,method:'POST',route:'/api/reader/open'})).status,405);
  const image=await request(url,{route:`/api/reader/image/0/0?book=${book.id}&token=${token}`});assert.equal(image.status,200);assert.equal(image.headers['content-type'],'image/png');
  assert.equal((await request(url,{token,route:`/api/reader/image/0/99?book=${book.id}`})).status,400);
  await reader.stopShare();assert.equal(reader.shareStatus().enabled,false);
  const next=await reader.startShare();assert.notEqual(next.urls[0],url);
  assert.equal((await request(next.urls[0],{token,route:'/api/reader/book'})).status,401);
  await reader.open(source);assert.equal(reader.shareStatus().enabled,false);
});
