import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chapterNumber,FolderRenamer} from '../folder-rename.js';
async function setup(t,names){const root=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-rename-'));for(const name of names){await fs.mkdir(path.join(root,name));await fs.writeFile(path.join(root,name,'001.png'),'original image bytes');}t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const selected=plan=>plan.rows.filter(r=>r.selected).map(r=>({id:r.id,to:r.to}));
test('extracts the marked chapter number rather than the download prefix, normalizes full-width/leading zeros and keeps decimal chapters',()=>{
  for(const [name,want] of [['001_第85话-原来你也有遇到','85'],['002_第86章','86'],['第00087話 完','87'],['第 ８８ 回','88'],['第89集','89'],['第90節','90'],['第91节','91'],['第085.500话','85.5'],['第000章','0']])assert.equal(chapterNumber(name).name,want);
  for(const name of ['001_番外','85','第85话-第86章合集','第八十五话'])assert.equal(chapterNumber(name).name,'');
});
test('preview changes nothing, ignores files/symlinks and renames selected immediate folders while preserving nested files',async t=>{
  const root=await setup(t,['001_第85话-原来你也有遇到','002_第86章','番外','87']);await fs.mkdir(path.join(root,'番外','第99话'));await fs.writeFile(path.join(root,'第88话.txt'),'leave me');await fs.symlink(path.join(root,'番外'),path.join(root,'第90话'));
  const tool=new FolderRenamer();const plan=await tool.preview(root);assert.equal(plan.rows.length,4);assert.equal((await fs.stat(path.join(root,'001_第85话-原来你也有遇到'))).isDirectory(),true);
  const original=await fs.stat(path.join(root,plan.rows.find(r=>r.to==='85').from));
  const result=await tool.apply(plan.id,selected(plan));assert.equal(result.changed,2);assert.equal(result.ok,true);
  assert.equal((await fs.stat(path.join(root,'85'))).ino,original.ino);assert.equal(await fs.readFile(path.join(root,'85','001.png'),'utf8'),'original image bytes');assert.equal((await fs.stat(path.join(root,'番外','第99话'))).isDirectory(),true);
  assert.equal(await fs.readFile(path.join(root,'第88话.txt'),'utf8'),'leave me');await assert.rejects(tool.apply(plan.id,selected(plan)),/已执行/);
});
test('duplicate targets and existing folders/files block the entire batch; unselecting or editing the duplicate resolves it',async t=>{
  const root=await setup(t,['001_第85话','002_第85章','003_第86話']);const tool=new FolderRenamer();let plan=await tool.preview(root);
  await assert.rejects(tool.apply(plan.id,selected(plan)),/多个文件夹/);assert.ok(await fs.stat(path.join(root,'001_第85话')));
  await fs.mkdir(path.join(root,'86'));await assert.rejects(tool.apply(plan.id,[{id:plan.rows.find(r=>r.to==='86').id,to:'86'}]),/已存在/);
  await fs.writeFile(path.join(root,'85'),'existing file');await assert.rejects(tool.apply(plan.id,[{id:plan.rows.find(r=>r.from==='001_第85话').id,to:'85'}]),/已存在/);assert.equal(await fs.readFile(path.join(root,'85'),'utf8'),'existing file');
  plan=await tool.preview(root);const result=await tool.apply(plan.id,[{id:plan.rows.find(r=>r.from==='001_第85话').id,to:'85-上'},{id:plan.rows.find(r=>r.from==='002_第85章').id,to:'85-下'}]);assert.equal(result.changed,2);
});
test('stale, forged, path-traversal and replaced sources are rejected before mutation',async t=>{
  const root=await setup(t,['第85话']);let clock=0;const tool=new FolderRenamer({now:()=>clock});let plan=await tool.preview(root);
  await assert.rejects(tool.apply('forged',selected(plan)),/预览/);
  for(const to of ['../escape','/absolute','..','x/y','x\\y','CON','bad.'])await assert.rejects(tool.apply(plan.id,[{id:plan.rows[0].id,to}]),/无效/);
  clock=600001;await assert.rejects(tool.apply(plan.id,selected(plan)),/过期/);
  plan=await tool.preview(root);await fs.rename(path.join(root,'第85话'),path.join(root,'moved'));await fs.symlink(path.join(root,'moved'),path.join(root,'第85话'));
  await assert.rejects(tool.apply(plan.id,selected(plan)),/已变化/);assert.equal(await fs.readFile(path.join(root,'moved','001.png'),'utf8'),'original image bytes');
});
test('a target appearing after preview is preserved, and a mid-batch failure rolls back completed moves',async t=>{
  const root=await setup(t,['第85话','第86话']);let calls=0;
  const tool=new FolderRenamer({rename:async(a,b)=>{if(++calls===2)throw new Error('simulated IO failure');return fs.rename(a,b);}});
  let plan=await tool.preview(root);await fs.mkdir(path.join(root,'85'));await fs.writeFile(path.join(root,'85','keep.txt'),'do not replace');
  await assert.rejects(tool.apply(plan.id,selected(plan)),/已存在/);assert.equal(await fs.readFile(path.join(root,'85','keep.txt'),'utf8'),'do not replace');await fs.rm(path.join(root,'85'),{recursive:true});
  plan=await tool.preview(root);await assert.rejects(tool.apply(plan.id,selected(plan)),/未保留任何改名/);
  for(const name of ['第85话','第86话'])assert.equal(await fs.readFile(path.join(root,name,'001.png'),'utf8'),'original image bytes');
  assert.deepEqual((await fs.readdir(root)).sort(),['第85话','第86话']);
});
test('rollback cannot overwrite a source recreated by another process; reports exactly which folders remain renamed',async t=>{
  const root=await setup(t,['第85话','第86话']);let calls=0;
  const tool=new FolderRenamer({rename:async(a,b)=>{if(++calls===2){await fs.mkdir(path.join(root,'第85话'));await fs.writeFile(path.join(root,'第85话','new.txt'),'external file');throw new Error('simulated failure');}return fs.rename(a,b);}});
  const plan=await tool.preview(root);const result=await tool.apply(plan.id,selected(plan));assert.equal(result.ok,false);assert.equal(result.changed,1);assert.equal(result.rows.find(r=>r.to==='85').status,'renamed');assert.ok(result.issues.length);
  assert.equal(await fs.readFile(path.join(root,'第85话','new.txt'),'utf8'),'external file');assert.equal(await fs.readFile(path.join(root,'85','001.png'),'utf8'),'original image bytes');
});
