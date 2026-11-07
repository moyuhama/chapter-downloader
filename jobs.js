import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { httpUrl, safeName, sleep } from './crawler.js';
import { defaultDownloadDirectory } from './directories.js';
const terminal = new Set(['completed', 'partial', 'stopped', 'interrupted', 'failed']);
export class Jobs {
  constructor(root, crawler, { defaultDirectory = defaultDownloadDirectory } = {}) { this.defaultDirectory = defaultDirectory; this.creating = false; this.root = root; this.crawler = crawler; this.jobs = new Map(); this.writes = Promise.resolve(); this.running = new Set(); }
  async init() {
    await fs.mkdir(path.join(this.root, 'data'), { recursive: true });
    try { const stored = JSON.parse(await fs.readFile(path.join(this.root, 'data/jobs.json'), 'utf8')); for (const job of stored) { if (!terminal.has(job.status)) job.status = 'interrupted'; this.jobs.set(job.id, job); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  list() { return [...this.jobs.values()].reverse().map(j => this.summary(j)); }
  summary(j) { return { ...j, chapters: j.chapters.map(c => ({ ...c, images: undefined, imageCount: c.images?.length || 0 })) }; }
  async persist() {
    const data = JSON.stringify([...this.jobs.values()], null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => { const file = path.join(this.root, 'data/jobs.json'); await fs.writeFile(file + '.tmp', data); await fs.rename(file + '.tmp', file); });
    return this.writes;
  }
  async create(input) {
    if (this.creating || [...this.jobs.values()].some(j => !terminal.has(j.status))) throw new Error('请先完成或停止当前任务');
    this.creating = true;
    try { return await this.createJob(input); } finally { this.creating = false; }
  }
  async createJob(input) {
    if (!Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > 5000) throw new Error('请选择 1–5000 个章节');
    const source = httpUrl(input.url); const title = safeName(input.title || '未命名作品');
    const directory = String(input.directory || this.defaultDirectory).trim();
    if (!path.isAbsolute(directory)) throw new Error('保存目录必须是完整的绝对路径');
    const options = input.options || {};
    for (const key of ['minWidth', 'minHeight']) if (!Number.isFinite(Number(options[key] ?? 200)) || Number(options[key] ?? 200) < 0) throw new Error('图片尺寸必须是非负数');
    const job = { id: randomUUID(), title, url: source, createdAt: new Date().toISOString(), status: 'queued', message: '等待开始', done: 0, failed: 0, total: 0,
      directory: path.resolve(directory), folderName: title, output: '',
      options: { chapterSelector: String(options.chapterSelector || ''), imageSelector: String(options.imageSelector || ''), nextSelector: String(options.nextSelector || ''), minWidth: Number(options.minWidth ?? 200), minHeight: Number(options.minHeight ?? 200), followPages: options.followPages !== false },
      chapters: input.chapters.map((c, i) => ({ title: String(c.title || `第 ${i + 1} 章`), url: httpUrl(c.url), number: i + 1, folder: `${String(i + 1).padStart(3, '0')}_${safeName(c.title || '章节')}`, status: 'pending', images: [], error: '' })) };
    if ([...this.jobs.values()].some(j => !terminal.has(j.status))) throw new Error('请先完成或停止当前任务');
    await fs.mkdir(job.directory, { recursive: true });
    // Reserve a new folder atomically. A new task never overwrites an older download.
    for (let number = 1; ; number++) {
      const name = number === 1 ? title : `${title} (${number})`;
      const output = path.join(job.directory, name);
      try { await fs.mkdir(output); job.folderName = name; job.output = output; break; }
      catch (e) { if (e.code !== 'EEXIST' || number >= 9999) throw e; }
    }
    this.jobs.set(job.id, job); await this.persist(); this.start(job); return this.summary(job);
  }
  recount(j) { j.total = j.chapters.reduce((n,c) => n + c.images.length, 0); j.done = j.chapters.reduce((n,c) => n + c.images.filter(i => i.status === 'done').length, 0); j.failed = j.chapters.reduce((n,c) => n + c.images.filter(i => i.status === 'failed').length, 0); }
  async control(id, action) {
    const j = this.jobs.get(id); if (!j) throw new Error('任务不存在');
    if (action === 'pause' && ['running', 'queued'].includes(j.status)) j.status = 'paused';
    else if (action === 'stop' && !terminal.has(j.status)) { j.status = 'stopped'; j.message = '已停止，可继续未完成项目'; }
    else if (action === 'resume') {
      if ([...this.jobs.values()].some(other => other.id !== id && !terminal.has(other.status))) throw new Error('另一个任务尚未结束');
      if (this.running.has(id)) { if (j.status === 'paused') j.status = 'running'; else throw new Error('正在收尾，请稍后继续'); }
      else { j.status = 'queued'; await this.persist(); this.start(j); }
    } else throw new Error('当前状态不支持此操作');
    await this.persist(); return this.summary(j);
  }
  async checkpoint(j) { while (j.status === 'paused') await sleep(180); if (j.status === 'stopped') throw new Error('__STOP__'); }
  start(j) { this.running.add(j.id); this.run(j).catch(async e => { if (j.status !== 'stopped') { j.status = 'failed'; j.message = e.message; } await this.persist(); }).finally(() => this.running.delete(j.id)); }
  async run(j) {
    j.status = 'running'; await fs.mkdir(j.output, { recursive: true });
    const chapterUrls = j.chapters.map(c => c.url);
    for (const c of j.chapters) {
      await this.checkpoint(j); if (c.status === 'completed') continue;
      j.current = c.number; j.message = `正在处理 ${c.title}`; c.error = ''; c.status = 'running'; await this.persist();
      const dir = path.join(j.output, c.folder); await fs.mkdir(dir, { recursive: true });
      try {
        if (!c.images.length || c.images.some(i => i.url.startsWith('blob:'))) {
          const images = await this.crawler.chapter(c.url, { ...j.options, chapterUrls }, () => this.checkpoint(j));
          if (!images.length) throw new Error('没有找到正文图片，请检查图片区域或降低尺寸过滤');
          c.images = images.map((img, i) => ({ ...img, index: i + 1, status: 'pending', file: '', error: '' }));
          this.recount(j); await this.persist();
        }
        let cursor = 0;
        const worker = async () => {
          while (cursor < c.images.length) {
            await this.checkpoint(j); if (cursor >= c.images.length) return; const img = c.images[cursor++];
            if (img.status === 'done') { try { await fs.access(path.join(dir, img.file)); continue; } catch { img.status = 'pending'; } }
            for (let attempt = 0; attempt < 3; attempt++) {
              await this.checkpoint(j);
              try {
                const { type, body } = await this.crawler.bytes(img);
                const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' }[type] || (/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(img.url)?.[1] || 'img');
                img.file = `${String(img.index).padStart(3, '0')}.${ext}`;
                await fs.writeFile(path.join(dir, img.file + '.part'), body); await fs.rename(path.join(dir, img.file + '.part'), path.join(dir, img.file));
                img.status = 'done'; img.error = ''; break;
              } catch (e) { if (e.message === '__STOP__') throw e; img.status = 'failed'; img.error = e.message; if (attempt < 2) await sleep(500 * (attempt + 1)); }
            }
            this.recount(j); await this.persist();
          }
        };
        const results = await Promise.allSettled([worker(), worker(), worker()]);
        const rejected = results.find(r => r.status === 'rejected'); if (rejected) throw rejected.reason;
        c.status = c.images.every(i => i.status === 'done') ? 'completed' : 'partial';
      } catch (e) { if (e.message === '__STOP__') throw e; c.status = 'failed'; c.error = e.message; }
      this.recount(j); await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(c, null, 2)); await this.persist();
    }
    await this.checkpoint(j);
    j.status = j.chapters.every(c => c.status === 'completed') ? 'completed' : 'partial';
    j.message = j.status === 'completed' ? '全部下载完成' : '处理结束，部分章节或图片失败，可点击重试';
    await this.persist();
  }
}
