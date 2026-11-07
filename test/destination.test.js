import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../jobs.js';
import { defaultDownloadDirectory } from '../directories.js';
const input = (extra={}) => ({url:'https://example.com/book',title:'解析出的作品名称',chapters:[{title:'第一章',url:'https://example.com/chapter'}],...extra});

test('uses the system Downloads default and supports an injected directory for isolated tests',async()=>{
  assert.equal(defaultDownloadDirectory,path.join(os.homedir(),'Downloads'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'destination-'));
  try{
    const defaults=path.join(root,'Downloads');const jobs=new Jobs(root,{}, {defaultDirectory:defaults});await jobs.init();jobs.start=()=>{};
    const job=await jobs.create(input());
    assert.equal(job.directory,defaults);assert.equal(job.folderName,'解析出的作品名称');assert.equal(job.output,path.join(defaults,'解析出的作品名称'));
    assert.equal((await fs.stat(job.output)).isDirectory(),true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('custom folder names and paths are fixed at creation; collisions preserve existing files',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'destination-'));
  try{
    const directory=path.join(root,'用户指定 目录');await fs.mkdir(path.join(directory,'自定义作品'),{recursive:true});
    await fs.writeFile(path.join(directory,'自定义作品','keep.txt'),'keep');
    const jobs=new Jobs(root,{}, {defaultDirectory:path.join(root,'Downloads')});await jobs.init();jobs.start=()=>{};
    const payload=input({directory,title:'自定义作品'});const job=await jobs.create(payload);
    payload.directory='/changed';payload.title='changed';
    assert.equal(job.output,path.join(directory,'自定义作品 (2)'));assert.equal(job.folderName,'自定义作品 (2)');
    assert.equal(await fs.readFile(path.join(directory,'自定义作品','keep.txt'),'utf8'),'keep');
    jobs.jobs.get(job.id).status='stopped';await jobs.persist();
    const restored=new Jobs(root,{}, {defaultDirectory:path.join(root,'different')});await restored.init();restored.start=()=>{};
    const resumed=await restored.control(job.id,'resume');assert.equal(resumed.output,job.output);assert.equal(resumed.directory,directory);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('invalid relative paths fail before a task starts and allow correcting the destination',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'destination-'));
  try{
    const jobs=new Jobs(root,{}, {defaultDirectory:path.join(root,'Downloads')});await jobs.init();jobs.start=()=>{};
    await assert.rejects(jobs.create(input({directory:'relative/path'})),/绝对路径/);assert.equal(jobs.jobs.size,0);
    const job=await jobs.create(input({directory:path.join(root,'valid')}));assert.equal(job.status,'queued');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
