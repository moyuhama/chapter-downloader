import http from 'node:http';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import QRCode from 'qrcode';

const types = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.svg':'image/png','.tif':'image/png','.tiff':'image/png'};
const order = new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const sorted = names => names.sort((a,b)=>order.compare(a,b)||a.localeCompare(b));
const imageName = name => !name.startsWith('.') && Object.hasOwn(types,path.extname(name).toLowerCase());
const json = (res,code,data) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const privateIp = ip => /^10\./.test(ip)||/^192\.168\./.test(ip)||/^172\.(1[6-9]|2\d|3[01])\./.test(ip);
export function lanAddresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter(n=>n?.family==='IPv4'&&!n.internal&&privateIp(n.address)).map(n=>n.address))];
}
export class Reader {
  constructor({stateDirectory,publicDirectory,addresses=lanAddresses,sharePort=Number(process.env.SHIYE_READER_PORT||3790)}) {
    this.stateDirectory=stateDirectory;this.publicDirectory=publicDirectory;this.addresses=addresses;this.sharePort=sharePort;
    this.book=null;this.sharing=null;this.opening=false;
  }
  async init() {
    try {const saved=JSON.parse(await fs.readFile(path.join(this.stateDirectory,'reader.json'),'utf8'));await this.open(saved.source);}
    catch { /* A disconnected disk or deleted folder can be selected again. */ }
  }
  summary() {
    if(!this.book)return null;
    const {id,title,chapters}=this.book;
    return {id,title,chapters:chapters.map(({id,title,files})=>({id,title,count:files.length})),total:chapters.reduce((n,c)=>n+c.files.length,0)};
  }
  async open(source) {
    if(this.opening)throw new Error('正在读取作品，请稍候');this.opening=true;
    try {
      if(typeof source!=='string'||!path.isAbsolute(source.trim()))throw new Error('请选择作品文件夹，或输入完整路径');
      const directory=await fs.realpath(source.trim());
      if(!(await fs.stat(directory)).isDirectory())throw new Error('请选择文件夹');
      const entries=await fs.readdir(directory,{withFileTypes:true});
      const chapters=[];let total=0;
      const add=async(dir,title)=>{
        const entries=await fs.readdir(dir,{withFileTypes:true});
        const files=sorted(entries.filter(e=>e.isFile()&&imageName(e.name)).map(e=>e.name));
        if(!files.length)return;
        total+=files.length;if(files.length>5000||total>50000)throw new Error('作品过大：每章最多 5000 张，作品最多 50000 张');
        chapters.push({id:chapters.length,title,directory:dir,files});
      };
      await add(directory,path.basename(directory));
      for(const name of sorted(entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>e.name)))await add(path.join(directory,name),name);
      if(!chapters.length)throw new Error('没有找到图片。请选择包含章节子文件夹或图片的作品文件夹');
      const id=createHash('sha256').update(directory).digest('hex').slice(0,24);
      const next={id,title:path.basename(directory),directory,chapters};
      await fs.mkdir(this.stateDirectory,{recursive:true});
      await fs.writeFile(path.join(this.stateDirectory,'reader.json'),JSON.stringify({source:directory}),{mode:0o600});
      // A new book always revokes the previous phone link.
      await this.stopShare();this.book=next;return this.summary();
    } finally {this.opening=false;}
  }
  chapter(bookId,chapterId) {
    if(!this.book||bookId!==this.book.id)throw new Error('作品已切换，请重新打开阅读器');
    const chapter=this.book.chapters.find(c=>String(c.id)===String(chapterId));
    if(!chapter)throw new Error('章节不存在');return chapter;
  }
  async imageFile(bookId,chapterId,index) {
    const chapter=this.chapter(bookId,chapterId);
    if(!/^\d+$/.test(String(index))||!chapter.files[Number(index)])throw new Error('图片不存在');
    const target=path.join(chapter.directory,chapter.files[Number(index)]);
    // Reject replaced chapter directories as well as symlinked individual files.
    if(await fs.realpath(chapter.directory)!==chapter.directory)throw new Error('文件夹已变化，请重新打开作品');
    const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{if(!(await handle.stat()).isFile())throw new Error('图片不是普通文件');return {handle,name:path.basename(target)};}
    catch(e){await handle.close();throw e;}
  }
  async chapterData(bookId,id) {
    const chapter=this.chapter(bookId,id);
    if(!chapter.dimensions) {
      const dimensions=new Array(chapter.files.length);let cursor=0;
      await Promise.all(Array.from({length:Math.min(6,chapter.files.length)},async()=>{
        while(cursor<chapter.files.length){const index=cursor++;let file;
          try{file=await this.imageFile(bookId,id,index);const m=await sharp(await file.handle.readFile()).metadata();
            const swap=m.orientation>=5&&m.orientation<=8;dimensions[index]={width:swap?m.height:m.width,height:swap?m.width:m.height};
          }catch{dimensions[index]={width:800,height:1100,unavailable:true};}finally{await file?.handle.close();}
        }
      }));chapter.dimensions=dimensions;
    }
    return {id:chapter.id,title:chapter.title,images:chapter.files.map((name,index)=>({index,name,...chapter.dimensions[index]}))};
  }
  async image(res,bookId,chapterId,index) {
    const file=await this.imageFile(bookId,chapterId,index);
    try {
      const ext=path.extname(file.name).toLowerCase();
      res.setHeader('Content-Type',types[ext]);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(['.svg','.tif','.tiff'].includes(ext)) {const data=await sharp(await file.handle.readFile()).rotate().png().toBuffer();res.end(data);}
      else {const stat=await file.handle.stat();res.setHeader('Content-Length',stat.size);await pipeline(file.handle.createReadStream({autoClose:false}),res).catch(()=>res.destroy());}
    } finally {await file.handle.close();}
  }
  async read(req,res,url) {
    if(req.method!=='GET')return json(res,405,{error:'手机阅读仅支持读取作品'});
    if(url.pathname==='/api/reader/book')return json(res,200,this.summary());
    const chapter=url.pathname.match(/^\/api\/reader\/chapter\/(\d+)$/);
    if(chapter)return json(res,200,await this.chapterData(url.searchParams.get('book'),chapter[1]));
    const image=url.pathname.match(/^\/api\/reader\/image\/(\d+)\/(\d+)$/);
    if(image){await this.image(res,url.searchParams.get('book'),image[1],image[2]);return;}
    return json(res,404,{error:'阅读接口不存在'});
  }
  shareStatus() {
    if(!this.sharing)return {enabled:false,urls:[]};
    return {enabled:true,urls:this.sharing.urls,qr:this.sharing.qr};
  }
  async startShare() {
    if(!this.book)throw new Error('请先打开作品');
    if(this.sharing)return this.shareStatus();
    const ips=this.addresses();if(!ips.length)throw new Error('未找到局域网地址，请让电脑连接 Wi-Fi 后重试');
    const token=randomBytes(24).toString('base64url');
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
      try {
        const host=req.headers.host;
        if(!ips.map(ip=>`${ip}:${server.address()?.port}`).includes(host)||req.headers.origin&&req.headers.origin!==`http://${host}`)return json(res,403,{error:'请使用电脑提供的阅读地址'});
        const url=new URL(req.url,`http://${host}`);
        if(url.pathname.startsWith('/api/')) {
          const supplied=req.headers.authorization?.replace(/^Bearer /,'')||url.searchParams.get('token')||'';
          const a=Buffer.from(supplied),b=Buffer.from(token);
          if(!this.sharing||a.length!==b.length||!timingSafeEqual(a,b))return json(res,401,{error:'阅读链接已失效，请在电脑上重新开启手机阅读'});
          return await this.read(req,res,url);
        }
        const files={'/reader.html':['reader.html','text/html; charset=utf-8'],'/reader.js':['reader.js','text/javascript'],'/reader.css':['reader.css','text/css']};
        const asset=files[url.pathname];
        if(req.method!=='GET'||!asset)return json(res,404,{error:'此地址仅提供阅读器'});
        res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.setHeader('Content-Type',asset[1]);res.end(await fs.readFile(path.join(this.publicDirectory,asset[0])));
      }catch(e){if(!res.headersSent)json(res,400,{error:e.message});else res.destroy();}
    });
    server.requestTimeout=15000;server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{server.once('error',e=>reject(new Error(e.code==='EADDRINUSE'?`手机阅读端口 ${this.sharePort} 已被占用，请关闭其他助手后重试`:e.message)));server.listen(this.sharePort,'0.0.0.0',resolve);});
    try {
      const urls=ips.map(ip=>`http://${ip}:${server.address().port}/reader.html#share=${token}`);
      const qr=await QRCode.toDataURL(urls[0],{margin:2,width:256,color:{dark:'#244c40',light:'#ffffff'}});
      this.sharing={server,urls,qr};return this.shareStatus();
    }catch(e){server.close();throw e;}
  }
  async stopShare() {
    if(!this.sharing)return;const {server}=this.sharing;this.sharing=null;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
