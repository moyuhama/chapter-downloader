import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const compare=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const key=name=>name.normalize('NFC').toLowerCase();
const identity=stat=>`${stat.dev}:${stat.ino}`;
const exists=async file=>{try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function renamedPath(file,directory,rows) {
  if(!file)return file;
  for(const row of rows.filter(r=>r.status==='renamed')){
    const from=path.join(directory,row.from);
    if(file===from||file.startsWith(from+path.sep))return path.join(directory,row.to)+file.slice(from.length);
  }
  return file;
}
export function chapterNumber(name) {
  const matches=[...name.normalize('NFKC').matchAll(/第\s*(\d+(?:\.\d+)?)\s*(?:话|話|章|回|集|节|節)/g)];
  if(matches.length!==1)return {name:'',reason:matches.length?'包含多个章节编号，请手动填写':'未找到“第数字话 / 章 / 話”等编号'};
  const [whole,fraction='']=matches[0][1].split('.');
  const integer=whole.replace(/^0+(?=\d)/,'');const decimal=fraction.replace(/0+$/,'');
  return {name:integer+(decimal?'.'+decimal:''),reason:''};
}
function validName(value) {
  return typeof value==='string'&&value===value.trim()&&value.length>0&&Buffer.byteLength(value)<=255&&
    !/[<>:"/\\|?*\x00-\x1f]/.test(value)&&!/[. ]$/.test(value)&&value!=='.'&&value!=='..'&&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
export class FolderRenamer {
  constructor({rename=fs.rename,now=Date.now}={}){this.rename=rename;this.now=now;this.plan=null;this.busy=false;}
  async preview(source) {
    if(this.busy)throw new Error('正在执行重命名，请稍候');
    if(typeof source!=='string'||!path.isAbsolute(source.trim()))throw new Error('请选择父文件夹，或输入完整路径');
    const directory=await fs.realpath(source.trim());
    const parent=await fs.stat(directory);if(!parent.isDirectory())throw new Error('请选择文件夹');
    const entries=await fs.readdir(directory,{withFileTypes:true});
    const dirs=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).sort((a,b)=>compare.compare(a.name,b.name)||a.name.localeCompare(b.name));
    if(!dirs.length)throw new Error('没有找到子文件夹，请选择包含章节文件夹的父目录');
    if(dirs.length>5000)throw new Error('单次最多处理 5000 个子文件夹');
    const rows=[];
    for(const entry of dirs){
      const stat=await fs.lstat(path.join(directory,entry.name));if(!stat.isDirectory()||stat.isSymbolicLink())continue;
      const extracted=chapterNumber(entry.name);
      rows.push({id:randomUUID(),from:entry.name,to:extracted.name,reason:extracted.reason,selected:!!extracted.name&&extracted.name!==entry.name,identity:identity(stat)});
    }
    const plan={id:randomUUID(),directory,identity:identity(parent),expires:this.now()+10*60*1000,rows};this.plan=plan;
    return {id:plan.id,directory,expires:plan.expires,rows:rows.map(({identity,...row})=>row),existing:entries.map(e=>e.name)};
  }
  async apply(id,changes) {
    if(this.busy)throw new Error('正在执行重命名，请勿重复提交');
    const plan=this.plan;
    if(!plan||id!==plan.id||this.now()>plan.expires)throw new Error('预览已过期或已执行，请重新预览');
    if(!Array.isArray(changes)||!changes.length||changes.length>5000)throw new Error('请至少勾选一个需要改名的文件夹');
    this.busy=true;const reserved=[],done=[];let selected=[];
    try{
      if(await fs.realpath(plan.directory)!==plan.directory||identity(await fs.stat(plan.directory))!==plan.identity)throw new Error('父目录已发生变化，请重新预览');
      const ids=new Set(),targets=new Set();
      const entries=await fs.readdir(plan.directory);const occupied=new Set(entries.map(key));
      selected=changes.map(change=>{
        const row=plan.rows.find(r=>r.id===change.id);
        if(!row||ids.has(change.id))throw new Error('所选文件夹无效或重复，请重新预览');ids.add(change.id);
        if(!validName(change.to))throw new Error(`目标名称无效：${row.from}`);
        if(change.to===row.from)throw new Error(`名称没有变化，请取消勾选：${row.from}`);
        if(targets.has(key(change.to)))throw new Error(`多个文件夹将改成“${change.to}”，请调整或取消勾选`);targets.add(key(change.to));
        if(occupied.has(key(change.to)))throw new Error(`目标“${change.to}”已存在，未执行任何改名`);
        return {...row,to:change.to};
      });
      for(const row of selected){const stat=await fs.lstat(path.join(plan.directory,row.from));if(!stat.isDirectory()||stat.isSymbolicLink()||identity(stat)!==row.identity)throw new Error(`文件夹已变化：${row.from}，请重新预览`);}
      // mkdir reserves each destination exclusively. rename can only replace our empty
      // reservation; a destination populated by another process makes it fail safely.
      for(const row of selected){const target=path.join(plan.directory,row.to);await fs.mkdir(target,{mode:0o700});reserved.push({file:target,identity:identity(await fs.lstat(target))});}
      for(const row of selected){
        const from=path.join(plan.directory,row.from),to=path.join(plan.directory,row.to);
        if(identity(await fs.lstat(from))!==row.identity)throw new Error(`文件夹已变化：${row.from}`);
        const reservation=reserved.find(r=>r.file===to);
        if(identity(await fs.lstat(to))!==reservation.identity)throw new Error(`目标文件夹已变化：${row.to}`);
        await this.rename(from,to);done.push(row);
      }
      this.plan=null;return {ok:true,changed:done.length,rows:done.map(({from,to})=>({from,to,status:'renamed'}))};
    }catch(error){
      const issues=[];
      for(const row of [...done].reverse()){
        const from=path.join(plan.directory,row.from),to=path.join(plan.directory,row.to);let reservation;
        try{
          if(identity(await fs.lstat(to))!==row.identity)throw new Error('目标已变化');
          await fs.mkdir(from,{mode:0o700});reservation={file:from,identity:identity(await fs.lstat(from))};reserved.push(reservation);
          await this.rename(to,from);done.splice(done.indexOf(row),1);
        }catch(e){issues.push(`${row.to} → ${row.from}：${e.message}`);}
      }
      if(done.length){this.plan=null;return {ok:false,changed:done.length,error:`执行中断，部分目录未能恢复：${error.message}`,issues,rows:selected.map(row=>({from:row.from,to:row.to,status:done.includes(row)?'renamed':'unchanged'}))};}
      throw new Error(done.length===0&&selected.length?`未保留任何改名：${error.message}`:error.message);
    }finally{
      // Never delete a directory that is not still our own empty reservation.
      for(const item of reserved){try{const stat=await exists(item.file);if(stat&&identity(stat)===item.identity)await fs.rmdir(item.file);}catch{}}
      this.busy=false;
    }
  }
}
