const $ = id => document.getElementById(id);
const hosted = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const backendBase = hosted ? 'http://127.0.0.1:3789' : location.origin;
let backendConnected = !hosted;
if (hosted) {
  $('backendPanel').classList.remove('hidden');
  document.querySelector('.local').innerHTML = '<i></i> Pages 界面 · 本机采集';
}
$('connectBackend').onclick = async () => {
  $('connectBackend').disabled = true;
  try {
    const r = await fetch(backendBase + '/api/health', { signal: AbortSignal.timeout(8000) });
    const result = await r.json();
    if (!r.ok || !result.ok || result.app !== 'chapter-downloader') throw new Error('未识别到下载服务');
    backendConnected = true; $('backendState').textContent = '已连接';
    notice('本机服务已连接，可以输入网址开始采集。'); await refresh();
  } catch (e) { backendConnected = false; $('backendState').textContent = '未连接'; notice('连接失败。请启动最新版本机程序，并检查浏览器的本地网络访问权限；也可直接打开本机界面。', true); }
  finally { $('connectBackend').disabled = false; }
};
let chapters = [], busy = false, parsedUrl = '', rulesUrl = '';
let currentJobId = sessionStorage.getItem('currentDownloadId');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labels = { queued:'等待中', running:'下载中', paused:'已暂停', completed:'已完成', partial:'有失败项', stopped:'已停止', interrupted:'上次已中断', failed:'失败', pending:'待处理' };
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(url, data) { if (!backendConnected) throw new Error('请先点击上方“连接本机服务”'); const r = await fetch(backendBase + url, data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw new Error(result.error || '请求失败'); return result; }
function options() { return { mode:$('mode').value, chapterSelector:$('chapterSelector').value.trim(), imageSelector:$('imageSelector').value.trim(), nextSelector:$('nextSelector').value.trim(), minWidth:Number($('minWidth').value), minHeight:Number($('minHeight').value), followPages:$('followPages').checked }; }
async function task(fn) {
  if (busy) return; busy = true;
  const buttons = ['demo','parse','login','pickChapter','pickImage','preview','download','saveRules']; buttons.forEach(id => $(id).disabled = true);
  try { await fn(); } catch(e) { notice(e.message, true); } finally { busy = false; buttons.forEach(id => $(id).disabled = false); }
}
async function loadRules() {
  const url = $('url').value.trim(); if (url === rulesUrl) return;
  const r = await api('/api/rules?url=' + encodeURIComponent(url));
  ['chapterSelector','imageSelector','nextSelector'].forEach(k => $(k).value = r[k] || '');
  ['minWidth','minHeight'].forEach(k => $(k).value = r[k] ?? 200); $('followPages').checked = r.followPages !== false; rulesUrl = url;
}
$('url').addEventListener('change', () => { parsedUrl = ''; $('chaptersPanel').classList.add('hidden'); });
$('url').addEventListener('blur', () => { if ($('url').value.trim() && !busy) loadRules().catch(e => notice(e.message, true)); });
$('parse').onclick = () => task(async () => {
  await loadRules(); notice('正在打开页面并识别章节，请稍候…');
  const url = $('url').value.trim(); const data = await api('/api/parse', { url, options:options() });
  chapters = data.chapters.map(c => ({...c, selected:true})); parsedUrl = url; $('bookTitle').value = data.title; $('chaptersPanel').classList.remove('hidden'); renderChapters();
  notice(!chapters.length ? '未找到章节。可以点选章节链接、自定义选择器，或将页面类型改为“当前页面就是一个章节”。' : data.confidence === 'review' ? `找到 ${chapters.length} 个候选链接，自动识别信心较低，请仔细核对并预览图片。` : `已识别 ${chapters.length} 个章节。请确认顺序，并预览正文图片。`, !chapters.length);
});
function renderChapters() {
  $('chapterCount').textContent = chapters.length + ' 章';
  $('chapterList').innerHTML = chapters.map((c,i) => `<label class="chapter"><input type="checkbox" data-index="${i}" ${c.selected?'checked':''}><span class="number">${String(i+1).padStart(3,'0')}</span><span class="name" title="${escape(c.url)}">${escape(c.title)}</span><a href="${escape(c.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">原页 ↗</a></label>`).join(''); updateSelected();
}
function updateSelected() { $('selectedCount').textContent = `已选 ${chapters.filter(c=>c.selected).length} 章`; $('selectAll').checked = chapters.length > 0 && chapters.every(c=>c.selected); $('selectAll').indeterminate = chapters.some(c=>c.selected) && !chapters.every(c=>c.selected); }
$('chapterList').onchange = e => { if(e.target.dataset.index !== undefined) { chapters[Number(e.target.dataset.index)].selected = e.target.checked; updateSelected(); } };
$('selectAll').onchange = () => { chapters.forEach(c => c.selected = $('selectAll').checked); renderChapters(); };
$('reverse').onclick = () => { chapters.reverse(); renderChapters(); };
$('login').onclick = () => task(async () => { const r = await api('/api/login', {url:$('url').value.trim()}); notice(r.message); });
for (const [id,kind,field] of [['pickChapter','chapter','chapterSelector'],['pickImage','image','imageSelector']]) $(id).onclick = () => task(async () => {
  const url = kind === 'image' && chapters.some(c=>c.selected) ? chapters.find(c=>c.selected).url : $('url').value.trim();
  notice('浏览器已开始打开，请在弹出窗口中点击' + (kind === 'chapter' ? '一个章节链接' : '一张正文图片') + '。');
  const r = await api('/api/pick', {url,kind}); $(field).value = r.selector; notice(`已选取区域：${r.selector}。请重新解析或预览以确认。`);
});
$('saveRules').onclick = () => task(async () => { await api('/api/rules',{url:$('url').value.trim(),options:options()}); notice('此网站的识别规则已保存。'); });
$('preview').onclick = () => task(async () => {
  const first = chapters.find(c=>c.selected); if(!first) throw new Error('请先选择章节');
  notice('正在加载正文图片…'); const r = await api('/api/preview', {url:first.url,options:options()});
  $('previewResult').innerHTML = `本章第一页识别到 <b>${r.count}</b> 张图片。${escape(r.note)}<br>` + r.images.map((u,i) => /^https?:/.test(u) ? `<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">查看图片 ${i+1} ↗</a>` : `内嵌图片 ${i+1}`).join(' · ');
  notice(r.count ? `预览完成：识别到 ${r.count} 张图片，请打开图片链接确认内容。` : '未识别到图片，请点选正文区域或降低尺寸限制。', !r.count);
});
$('download').onclick = () => task(async () => {
  if(parsedUrl !== $('url').value.trim()) throw new Error('网址已变化，请重新解析');
  const selected = chapters.filter(c=>c.selected); if(!selected.length) throw new Error('请选择章节');
  const job = await api('/api/jobs', { url:parsedUrl, title:$('bookTitle').value, chapters:selected.map(({title,url})=>({title,url})), options:options() });
  currentJobId = job.id; sessionStorage.setItem('currentDownloadId', job.id);
  notice('下载任务已开始。可以在下方查看进度。'); await refresh();
});
let refreshing = false;
async function refresh() {
  if (refreshing || !backendConnected) return; refreshing = true;
  try {
    const allJobs = await api('/api/jobs');
    let current = allJobs.find(j => j.id === currentJobId);
    if (!current) {
      current = allJobs.find(j => ['queued', 'running', 'paused', 'interrupted'].includes(j.status));
      currentJobId = current?.id || null;
      if (currentJobId) sessionStorage.setItem('currentDownloadId', currentJobId);
      else sessionStorage.removeItem('currentDownloadId');
    }
    $('downloadPanel').classList.toggle('hidden', !current);
    if (!current) { $('jobs').innerHTML = ''; return; }
    const jobs = [current];
    // Retain focused controls while updating progress.
    const focused = document.activeElement?.dataset;
    const openDetails = new Set([...document.querySelectorAll('.job details[open]')].map(d => d.closest('.job').querySelector('[data-id]').dataset.id));
    $('jobs').innerHTML = jobs.map(j => {
      const percent = j.total ? Math.round(j.done / j.total * 100) : 0;
      const active = ['running','queued','paused'].includes(j.status);
      return `<article class="job"><div class="job-top"><strong>${escape(j.title)}</strong><span class="status ${j.status}">${labels[j.status]}</span></div><div class="progress"><i style="width:${percent}%"></i></div><div class="job-message">${escape(j.message)}</div><div class="stats"><span>章节 <b>${j.chapters.filter(c=>c.status==='completed').length} / ${j.chapters.length}</b></span><span>图片 <b>${j.done} / ${j.total}</b></span><span>失败 <b>${j.failed}</b></span></div><div class="job-actions">${['running','queued'].includes(j.status)?`<button data-id="${j.id}" data-action="pause">暂停</button>`:''}${!['running','queued','completed'].includes(j.status)?`<button data-id="${j.id}" data-action="resume">${['partial','failed'].includes(j.status)?'重试失败项':'继续下载'}</button>`:''}${active?`<button data-id="${j.id}" data-action="stop">停止</button>`:''}<button data-id="${j.id}" data-action="open">打开文件夹 ↗</button></div><div class="job-path">${escape(j.output)}</div><details class="chapter-status" ${openDetails.has(j.id)?'open':''}><summary>查看章节状态</summary>${j.chapters.map(c=>`<div>${String(c.number).padStart(3,'0')} · ${escape(c.title)} — ${labels[c.status] || c.status} (${c.imageCount} 张) ${escape(c.error)}</div>`).join('')}</details></article>`;
    }).join('');
    if(focused?.action) document.querySelector(`[data-id="${focused.id}"][data-action="${focused.action}"]`)?.focus();
  } catch(e) { notice('服务连接失败：' + e.message, true); } finally { refreshing = false; }
}
$('jobs').onclick = async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  b.disabled = true; try { const r = await api(`/api/jobs/${b.dataset.id}/${b.dataset.action}`,{}); if(b.dataset.action === 'open') notice('保存位置：' + r.path); await refresh(); } catch(e) { notice(e.message,true); } finally { b.disabled = false; }
};
refresh(); setInterval(refresh, 1800);

$('demo').onclick = () => { $('url').value = backendBase + '/demo/'; rulesUrl = ''; $('mode').value = 'auto'; $('parse').click(); };
