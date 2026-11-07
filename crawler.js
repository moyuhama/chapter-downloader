import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

export function httpUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('请输入完整的 http / https 网址');
  u.hash = ''; return u.href;
}
export function safeName(value) {
  return String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 90) || '未命名';
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export class Crawler {
  constructor(root) { this.root = root; this.context = null; this.launching = null; }
  async browser() {
    if (!this.launching) this.launching = chromium.launchPersistentContext(path.join(this.root, 'browser'), {
      headless: process.env.CRAWLER_HEADLESS === '1', executablePath: process.env.SHIYE_BROWSER_EXECUTABLE || undefined, viewport: { width: 1280, height: 900 }, acceptDownloads: false,
    }).then(c => { this.context = c; c.on('close', () => { this.launching = null; this.context = null; }); return c; }).catch(e => { this.launching = null; throw new Error(`浏览器启动失败，请先运行 npm run setup。${e.message}`); });
    return this.launching;
  }
  async page(url) {
    const ctx = await this.browser(); const page = await ctx.newPage();
    page.on('dialog', d => d.dismiss());
    try { await page.goto(httpUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(900); return page; }
    catch (e) { await page.close(); throw e; }
  }
  async scroll(page, checkpoint = async () => {}) {
    let stable = 0, previous = -1;
    for (let i = 0; i < 120; i++) {
      await checkpoint();
      const state = await page.evaluate(() => {
        window.scrollBy(0, Math.max(600, innerHeight * .85));
        return { bottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 8, height: document.documentElement.scrollHeight };
      });
      stable = state.bottom && state.height === previous ? stable + 1 : 0; previous = state.height;
      if (stable >= 3) break; await page.waitForTimeout(220);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  async catalog(url, options = {}) {
    const page = await this.page(url);
    try {
      await this.scroll(page);
      return await page.evaluate(({ selector, mode }) => {
        const title = (document.querySelector('h1')?.textContent || document.title || '未命名作品').trim();
        if (mode === 'chapter') return { title, chapters: [{ title, url: location.href }], confidence: 'single' };
        const normalize = a => { try { const u = new URL(a.href, location.href); u.hash = ''; return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
        const all = [...document.querySelectorAll(selector || 'a[href]')].filter(a => a.textContent.trim() && normalize(a));
        const chapterPattern = /第\s*[\d一二三四五六七八九十百千万零〇两]+\s*[章节回话卷集]|chapter\s*\d|episode\s*\d|(?:^|\s)\d+\s*[.、:：]/i;
        let anchors = selector ? all : all.filter(a => chapterPattern.test(a.textContent.trim()));
        let confidence = selector ? 'custom' : 'auto';
        if (!anchors.length) {
          const groups = new Map();
          for (const a of all) {
            if (new URL(a.href).origin !== location.origin || a.closest('header,footer,nav')) continue;
            const parent = a.parentElement; const container = parent?.tagName === 'LI' || parent?.tagName === 'DD' ? parent.parentElement : parent;
            if (!groups.has(container)) groups.set(container, []); groups.get(container).push(a);
          }
          anchors = [...groups.values()].filter(a => a.length >= 3).sort((a, b) => b.length - a.length)[0] || []; confidence = 'review';
        }
        const seen = new Set(); const chapters = anchors.flatMap(a => {
          const url = normalize(a); if (!url || url === location.href || seen.has(url)) return []; seen.add(url);
          return [{ title: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 160), url }];
        });
        return { title, chapters, confidence };
      }, { selector: options.chapterSelector || '', mode: options.mode });
    } finally { await page.close(); }
  }
  async images(page, options = {}) {
    await this.scroll(page, options.checkpoint);
    return page.evaluate(({ selector, minWidth, minHeight, nextSelector }) => {
      const roots = selector ? [...document.querySelectorAll(selector)] : [...document.querySelectorAll('main,article,[id*="reader"],[class*="reader"],[id*="comic"],[class*="comic"],[id*="content"],[class*="content"]')];
      const excluded = el => !!el.closest('header,footer,nav,aside,[class*="advert"],[id*="advert"],[class~="ads"],[class*="avatar"],[class*="logo"]');
      const candidates = el => [...el.querySelectorAll('img')].filter(img => !excluded(img));
      const root = selector ? null : roots.sort((a, b) => candidates(b).length - candidates(a).length)[0] || document.body;
      const nodes = selector ? [...new Set(roots.flatMap(r => r.matches('img') ? [r] : [...r.querySelectorAll('img')]))] : candidates(root);
      const seen = new Set(); const images = [];
      for (const img of nodes) {
        if (!selector && excluded(img)) continue;
        const w = img.naturalWidth || Number(img.getAttribute('width')) || img.width;
        const h = img.naturalHeight || Number(img.getAttribute('height')) || img.height;
        // Unknown dimensions are retained for lazy images; known small images are filtered.
        if ((w && w < minWidth) || (h && h < minHeight)) continue;
        const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
        const best = srcset?.split(',').map(s => s.trim().split(/\s+/)).sort((a,b) => parseFloat(b[1] || '1') - parseFloat(a[1] || '1'))[0]?.[0];
        const raw = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-url') || best || img.currentSrc || img.src;
        if (!raw) continue;
        try { const url = new URL(raw, document.baseURI).href; if (!/^(https?:|data:image\/|blob:)/.test(url) || seen.has(url)) continue; seen.add(url); images.push({ url, pageUrl: location.href }); } catch {}
      }
      const next = nextSelector ? document.querySelector(nextSelector) : [...document.querySelectorAll('a[href]')].find(a => a.rel === 'next' && /[?&](?:page|p)=|\/page\//i.test(a.href) && !/下一章|下一话|next chapter/i.test(a.textContent) || /^(下一页|下页|next\s*page|next\s*[›»→])$/i.test(a.textContent.trim()));
      return { images, next: next?.href || null, title: document.title };
    }, { selector: options.imageSelector || '', nextSelector: options.nextSelector || '', minWidth: options.minWidth ?? 200, minHeight: options.minHeight ?? 200 });
  }
  async chapter(url, options, checkpoint, onPage) {
    const page = await this.page(url); const visited = new Set(); const seen = new Set(); const images = [];
    try {
      while (true) {
        await checkpoint(); const current = page.url();
        if (visited.has(current)) break; visited.add(current);
        const result = await this.images(page, { ...options, checkpoint });
        for (const img of result.images) if (!seen.has(img.url)) {
          seen.add(img.url);
          if (img.url.startsWith('blob:')) {
            img.url = await page.evaluate(async url => {
              const blob = await (await fetch(url)).blob();
              return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取临时图片失败')); reader.readAsDataURL(blob); });
            }, img.url);
          }
          images.push(img);
        }
        await onPage?.(page, images);
        if (!result.next || options.followPages === false) break;
        const next = httpUrl(result.next);
        if (visited.has(next)) break;
        if (new URL(next).origin !== new URL(url).origin || options.chapterUrls?.includes(next)) break;
        if (visited.size >= 100) throw new Error('单章超过 100 页，请检查下一页规则');
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      return images;
    } finally { await page.close(); }
  }
  async bytes(item) {
    if (item.url.startsWith('data:')) {
      const match = item.url.match(/^data:(image\/[\w.+-]+)(;base64)?,([\s\S]*)$/);
      if (!match) throw new Error('不支持的内嵌图片');
      return { type: match[1], body: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3])) };
    }
    if (item.url.startsWith('blob:')) throw new Error('临时 blob 图片需在原页面下载；该站点暂不支持');
    const ctx = await this.browser(); const response = await ctx.request.get(httpUrl(item.url), { headers: { Referer: item.pageUrl }, timeout: 30000 });
    try {
      if (!response.ok()) throw new Error(`图片请求返回 HTTP ${response.status()}`);
      const type = (response.headers()['content-type'] || '').split(';')[0];
      if (!type.startsWith('image/') && type !== 'application/octet-stream') throw new Error(`链接返回的不是图片（${type || '未知类型'}）`);
      const body = await response.body(); if (!body.length) throw new Error('图片为空');
      return { type, body };
    } finally { await response.dispose(); }
  }
  async pick(url, kind) {
    const page = await this.page(url);
    try {
      return await new Promise(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('点选超时，请重试')), 180000);
        page.once('close', () => { clearTimeout(timer); reject(new Error('已关闭点选窗口')); });
        try {
          await page.exposeFunction('__chapterPick', value => { clearTimeout(timer); resolve(value); });
          await page.evaluate(kind => {
            const selector = el => {
              if (el.id) return '#' + CSS.escape(el.id);
              const classes = [...el.classList].filter(c => !c.startsWith('__')).slice(0, 3);
              if (classes.length) return el.tagName.toLowerCase() + classes.map(c => '.' + CSS.escape(c)).join('');
              const segments = []; while (el && el !== document.body) { const siblings = [...el.parentElement.children].filter(c => c.tagName === el.tagName); segments.unshift(el.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : '')); el = el.parentElement; } return 'body > ' + segments.join(' > ');
            };
            const bar = document.createElement('div'); bar.textContent = kind === 'chapter' ? '章节采集器：点击一个章节链接，自动选择同组链接。关闭窗口可取消。' : '章节采集器：点击一张正文图片，选择它所在的图片区域。关闭窗口可取消。';
            Object.assign(bar.style, { position: 'fixed', top: '0', left: '0', right: '0', padding: '18px', background: '#174f47', color: 'white', zIndex: 2147483647, font: '16px sans-serif', pointerEvents: 'none' }); document.body.append(bar);
            let old; document.addEventListener('mousemove', e => { if (old) old.style.outline = ''; old = e.target; old.style.outline = '3px solid #00b899'; }, true);
            document.addEventListener('click', e => {
              e.preventDefault(); e.stopImmediatePropagation();
              let target = kind === 'chapter' ? e.target.closest('a[href]') : e.target.closest('img'); if (!target) return;
              if (kind === 'chapter') {
                let container = target.parentElement;
                while (container && container !== document.body && container.querySelectorAll('a[href]').length < 2) container = container.parentElement;
                window.__chapterPick({ selector: selector(container || target.parentElement) + ' a[href]' });
              } else {
                let container = target.parentElement;
                while (container && container !== document.body && container.querySelectorAll('img').length < 2) container = container.parentElement;
                window.__chapterPick({ selector: selector(container || target.parentElement) });
              }
            }, true);
          }, kind);
        } catch (e) { clearTimeout(timer); reject(e); }
      });
    } finally { if (!page.isClosed()) await page.close(); }
  }
  async close() { if (this.context) await this.context.close(); }
}
