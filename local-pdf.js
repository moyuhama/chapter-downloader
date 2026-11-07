import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeName } from './crawler.js';
import { defaultDownloadDirectory } from './directories.js';
import { generateChapterPdf } from './pdf.js';
import { PdfQueue } from './pdf-queue.js';
const extensions = new Set(['.jpg','.jpeg','.png','.webp','.avif','.gif','.svg','.tif','.tiff']);
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value.trim())) throw new Error('请输入完整的文件夹路径'); return path.resolve(value.trim()); }
function imageName(name) { return typeof name === 'string' && name === path.basename(name) && !/[\\/]/.test(name) && extensions.has(path.extname(name).toLowerCase()); }
export async function scanImageDirectory(value) {
  const directory = absolute(value);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = entries.filter(e => e.isFile() && !e.name.startsWith('.') && imageName(e.name)).map(e=>e.name).sort((a,b)=>collator.compare(a,b)||a.localeCompare(b));
  if (!names.length) throw new Error('此文件夹中没有支持的图片，请选择直接包含图片的章节文件夹');
  if (names.length > 5000) throw new Error('单次最多转换 5000 张图片');
  return { directory, name: safeName(path.basename(directory)), files: names.map(name=>({name})) };
}
export class LocalPdf {
  constructor({ pdfQueue = new PdfQueue(), pdfBuilder = generateChapterPdf, defaultDirectory = defaultDownloadDirectory } = {}) {
    this.queue = pdfQueue; this.builder = pdfBuilder; this.defaultDirectory = defaultDirectory; this.current = null; this.busy = false; this.creating = false;
  }
  get(id) { if (!this.current || this.current.id !== id) throw new Error('转换任务不存在，请重新选择图片'); return { ...this.current, files: undefined }; }
  async create(input) {
    if (this.busy || this.creating) throw new Error('请等待当前转换完成或取消后再开始');
    this.creating = true;
    try {
      const source = absolute(input.source), directory = absolute(input.directory || this.defaultDirectory);
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 5000 || new Set(input.files).size !== input.files.length || !input.files.every(imageName)) throw new Error('请选择 1–5000 张不重复的图片');
      for (const name of input.files) if (!(await fs.lstat(path.join(source,name))).isFile()) throw new Error(`图片不是普通文件：${name}`);
      const name = safeName(String(input.name || path.basename(source)).replace(/\.pdf$/i,''));
      await fs.mkdir(directory, { recursive:true });
      let output;
      for (let n=1; ; n++) {
        output = path.join(directory, `${name}${n===1?'':` (${n})`}.pdf`);
        try { await fs.access(output); } catch (e) { if(e.code==='ENOENT') break; throw e; }
        if(n>=9999) throw new Error('同名 PDF 太多，请修改输出名称');
      }
      const task = { id:randomUUID(), source, directory, name:path.basename(output), output, splitLongImages:input.splitLongImages!==false, files:[...input.files], status:'queued', done:0, total:input.files.length, pages:0, error:'', cancelled:false };
      this.current=task; this.busy=true;
      this.queue.run(async()=>{
        try {
          if(task.cancelled)throw new Error('__STOP__'); task.status='generating';
          const result=await this.builder({ directory:source, images:task.files.map((file,i)=>({file,index:i+1,status:'done'})), output, title:name, splitLongImages:task.splitLongImages, exclusive:true,
            checkpoint:async()=>{if(task.cancelled)throw new Error('__STOP__');}, onProgress:async p=>Object.assign(task,p) });
          task.pages=result.pages;task.status='completed';
        } catch(e) {task.status=e.message==='__STOP__'?'stopped':'failed';task.error=e.message==='__STOP__'?'':e.code==='EEXIST'?'目标 PDF 已存在，请重新开始以使用新的文件名':e.message;}
        finally{this.busy=false;}
      }).catch(e=>{task.status='failed';task.error=e.message;this.busy=false;});
      return this.get(task.id);
    } finally{this.creating=false;}
  }
  stop(id) { this.get(id); if(this.busy){this.current.cancelled=true;this.current.status='stopping';} return this.get(id); }
}
