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
    await loadDownloadDefaults(); notice('本机服务已连接，可以输入网址开始采集。'); await refresh();
  } catch (e) { backendConnected = false; $('backendState').textContent = '未连接'; notice('连接失败。请启动最新版本机程序，并检查浏览器的本地网络访问权限；也可直接打开本机界面。', true); }
  finally { $('connectBackend').disabled = false; }
};
let chapters = [], busy = false, parsedUrl = '', rulesUrl = '';
let currentJobId = sessionStorage.getItem('currentDownloadId');
let currentJobStatus = '', sourceRevision = 0, rulesRequest = 0, previewRevision = 0;
let restoreJobOnLoad = true, detachedJob = false;
let inputUrl = $('url').value.trim();
let outputLocked = false, directorySeparator = '/';
function updateOutputHint(output = '') {
  const directory = $('downloadDirectory').value.trim().replace(/[\\/]$/, '');
  const name = $('bookTitle').value.trim();
  const target = output || (directory && name ? directory + directorySeparator + name : '系统下载目录');
  $('outputHint').textContent = outputLocked ? `已锁定保存位置：${target}` : `将保存到：${target}。开始下载前可修改；同名文件夹会自动加序号。`;
}
function setOutputLocked(locked, output = '') {
  outputLocked = locked;
  $('chapterConcurrency').disabled = locked;
  $('generatePdf').disabled = locked;
  $('splitLongImages').disabled = locked || !$('generatePdf').checked;
  $('bookTitle').readOnly = locked; $('downloadDirectory').readOnly = locked;
  $('chooseDirectory').disabled = locked || busy;
  updateOutputHint(output);
}
async function loadDownloadDefaults() {
  const settings = await api('/api/download-settings');
  directorySeparator = settings.separator || '/';
  if (!$('downloadDirectory').value && !outputLocked) $('downloadDirectory').value = settings.directory;
  if (!$('localPdfDirectory').value) $('localPdfDirectory').value = settings.directory;
  updateOutputHint();
}
$('chooseDirectory').onclick = () => task(async () => {
  if (outputLocked) return;
  notice('请在系统窗口中选择保存目录…');
  const result = await api('/api/choose-directory', {});
  if (result.directory && !outputLocked) { $('downloadDirectory').value = result.directory; updateOutputHint(); notice('保存目录已更改，开始下载前仍可调整。'); }
  else notice('已取消选择，保存目录保持原样。');
});
for (const id of ['bookTitle', 'downloadDirectory']) $(id).addEventListener('input', () => updateOutputHint());
function isCurrent(revision, url) { return revision === sourceRevision && url === $('url').value.trim(); }
function clearPreview() { previewRevision++; $('previewResult').innerHTML = ''; }
function resetResults() {
  sourceRevision++;
  chapters = []; parsedUrl = '';
  setOutputLocked(false);
  $('bookTitle').value = '';
  $('chapterList').innerHTML = '';
  $('chapterCount').textContent = '';
  $('selectedCount').textContent = '';
  $('selectAll').checked = false; $('selectAll').indeterminate = false;
  $('chaptersPanel').classList.add('hidden');
  clearPreview();
  restoreJobOnLoad = false;
  // An ongoing download remains controllable; completed results belong to the old source.
  detachedJob = ['queued', 'running', 'paused'].includes(currentJobStatus);
  if (!detachedJob) {
    currentJobId = null; currentJobStatus = '';
    sessionStorage.removeItem('currentDownloadId');
    $('jobs').innerHTML = ''; $('downloadPanel').classList.add('hidden');
  }
}
function sourceChanged() {
  const url = $('url').value.trim();
  if (url === inputUrl) return;
  inputUrl = url; resetResults(); rulesUrl = ''; rulesRequest++;
  ['chapterSelector','imageSelector','nextSelector'].forEach(k => $(k).value = '');
  ['minWidth','minHeight'].forEach(k => $(k).value = 200);
  $('followPages').checked = true;
  notice('网址已更换，请重新解析。');
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const labels = { queued:'等待中', running:'下载中', paused:'已暂停', completed:'已完成', partial:'有失败项', stopped:'已停止', interrupted:'上次已中断', failed:'失败', pending:'待处理' };
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(url, data) { if (!backendConnected) throw new Error('请先点击上方“连接本机服务”'); const r = await fetch(backendBase + url, data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw new Error(result.error || '请求失败'); return result; }
function options() { return { mode:$('mode').value, chapterSelector:$('chapterSelector').value.trim(), imageSelector:$('imageSelector').value.trim(), nextSelector:$('nextSelector').value.trim(), minWidth:Number($('minWidth').value), minHeight:Number($('minHeight').value), followPages:$('followPages').checked }; }
async function task(fn) {
  if (busy) return; busy = true;
  const revision = sourceRevision;
  const buttons = ['demo','parse','login','pickChapter','pickImage','preview','download','saveRules','chooseDirectory']; buttons.forEach(id => $(id).disabled = true);
  try { await fn(); } catch(e) { if (revision === sourceRevision) notice(e.message, true); } finally { busy = false; buttons.forEach(id => $(id).disabled = false); $('chooseDirectory').disabled = outputLocked; }
}
async function loadRules() {
  const url = $('url').value.trim(); if (url === rulesUrl) return true;
  const revision = sourceRevision, request = ++rulesRequest;
  const r = await api('/api/rules?url=' + encodeURIComponent(url));
  if (!isCurrent(revision, url) || request !== rulesRequest) return false;
  ['chapterSelector','imageSelector','nextSelector'].forEach(k => $(k).value = r[k] || '');
  ['minWidth','minHeight'].forEach(k => $(k).value = r[k] ?? 200); $('followPages').checked = r.followPages !== false; rulesUrl = url; return true;
}
$('url').addEventListener('input', sourceChanged);
$('url').addEventListener('change', sourceChanged);
$('url').addEventListener('blur', () => {
  const revision = sourceRevision;
  if ($('url').value.trim() && !busy) loadRules().catch(e => { if (revision === sourceRevision) notice(e.message, true); });
});
$('parse').onclick = () => {
  if (busy) return;
  sourceChanged(); resetResults();
  return task(async () => {
    const revision = sourceRevision, url = $('url').value.trim();
    if (!await loadRules() || !isCurrent(revision, url)) return;
    notice('正在打开页面并识别章节，请稍候…');
    const data = await api('/api/parse', { url, options:options() });
    if (!isCurrent(revision, url)) return;
    chapters = data.chapters.map(c => ({...c, selected:true})); parsedUrl = url; $('bookTitle').value = data.title; updateOutputHint(); $('chaptersPanel').classList.remove('hidden'); renderChapters();
    notice(!chapters.length ? '未找到章节。可以点选章节链接、自定义选择器，或将页面类型改为“当前页面就是一个章节”。' : data.confidence === 'review' ? `找到 ${chapters.length} 个候选链接，自动识别信心较低，请仔细核对并预览图片。` : `已识别 ${chapters.length} 个章节。请确认顺序，并预览正文图片。`, !chapters.length);
  });
};
function renderChapters() {
  clearPreview();
  $('chapterCount').textContent = chapters.length + ' 章';
  $('chapterList').innerHTML = chapters.map((c,i) => `<label class="chapter"><input type="checkbox" data-index="${i}" ${c.selected?'checked':''}><span class="number">${String(i+1).padStart(3,'0')}</span><span class="name" title="${escape(c.url)}">${escape(c.title)}</span><a href="${escape(c.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">原页 ↗</a></label>`).join(''); updateSelected();
}
function updateSelected() { $('selectedCount').textContent = `已选 ${chapters.filter(c=>c.selected).length} 章`; $('selectAll').checked = chapters.length > 0 && chapters.every(c=>c.selected); $('selectAll').indeterminate = chapters.some(c=>c.selected) && !chapters.every(c=>c.selected); }
$('chapterList').onchange = e => { if(e.target.dataset.index !== undefined) { chapters[Number(e.target.dataset.index)].selected = e.target.checked; clearPreview(); updateSelected(); } };
$('selectAll').onchange = () => { chapters.forEach(c => c.selected = $('selectAll').checked); renderChapters(); };
$('reverse').onclick = () => { chapters.reverse(); renderChapters(); };
$('login').onclick = () => task(async () => { const revision = sourceRevision, url = $('url').value.trim(); const r = await api('/api/login', {url}); if (isCurrent(revision, url)) notice(r.message); });
for (const [id,kind,field] of [['pickChapter','chapter','chapterSelector'],['pickImage','image','imageSelector']]) $(id).onclick = () => task(async () => {
  const revision = sourceRevision, source = $('url').value.trim();
  const url = kind === 'image' && chapters.some(c=>c.selected) ? chapters.find(c=>c.selected).url : $('url').value.trim();
  notice('浏览器已开始打开，请在弹出窗口中点击' + (kind === 'chapter' ? '一个章节链接' : '一张正文图片') + '。');
  const r = await api('/api/pick', {url,kind}); if (!isCurrent(revision, source)) return; clearPreview(); $(field).value = r.selector; notice(`已选取区域：${r.selector}。请重新解析或预览以确认。`);
});
$('saveRules').onclick = () => task(async () => { const revision = sourceRevision, url = $('url').value.trim(); await api('/api/rules',{url,options:options()}); if (isCurrent(revision, url)) notice('此网站的识别规则已保存。'); });
$('preview').onclick = () => task(async () => {
  const first = chapters.find(c=>c.selected); if(!first) throw new Error('请先选择章节');
  clearPreview(); const preview = previewRevision, revision = sourceRevision, source = $('url').value.trim();
  notice('正在加载正文图片…'); const r = await api('/api/preview', {url:first.url,options:options()});
  if (!isCurrent(revision, source) || preview !== previewRevision) return;
  $('previewResult').innerHTML = `本章第一页识别到 <b>${r.count}</b> 张图片。${escape(r.note)}<br>` + r.images.map((u,i) => /^https?:/.test(u) ? `<a href="${escape(u)}" target="_blank" rel="noopener noreferrer">查看图片 ${i+1} ↗</a>` : `内嵌图片 ${i+1}`).join(' · ');
  notice(r.count ? `预览完成：识别到 ${r.count} 张图片，请打开图片链接确认内容。` : '未识别到图片，请点选正文区域或降低尺寸限制。', !r.count);
});
$('download').onclick = () => task(async () => {
  if(parsedUrl !== $('url').value.trim()) throw new Error('网址已变化，请重新解析');
  const selected = chapters.filter(c=>c.selected); if(!selected.length) throw new Error('请选择章节');
  const revision = sourceRevision, source = parsedUrl;
  const input = { url:parsedUrl, title:$('bookTitle').value, directory:$('downloadDirectory').value.trim(), chapterConcurrency:Number($('chapterConcurrency').value || 2), generatePdf:$('generatePdf').checked, splitLongImages:$('splitLongImages').checked, chapters:selected.map(({title,url})=>({title,url})), options:options() };
  let started = false;
  setOutputLocked(true);
  try {
    const job = await api('/api/jobs', input);
    started = true;
    if (!isCurrent(revision, source)) return;
    currentJobStatus = job.status; restoreJobOnLoad = false; detachedJob = false;
    currentJobId = job.id; sessionStorage.setItem('currentDownloadId', job.id);
    $('bookTitle').value = job.folderName || job.title;
    $('downloadDirectory').value = job.directory || input.directory;
    setOutputLocked(true, job.output);
    notice('下载任务已开始，文件夹名称和保存目录已锁定。'); await refresh();
  } finally { if (!started && isCurrent(revision, source)) setOutputLocked(false); }
});
const pdfLabels = { pending:'待生成', queued:'排队中', generating:'生成中', completed:'已生成', failed:'生成失败' };
function pdfLink(j, c) { return `${backendBase}/api/jobs/${encodeURIComponent(j.id)}/chapters/${c.number}/pdf`; }
function chapterStatus(j, c) {
  const pdf = j.generatePdf ? ` · PDF ${pdfLabels[c.pdf?.status] || (c.status === 'completed' ? '待生成' : '等待图片齐全')}${c.pdf?.status === 'generating' ? ` (${c.pdf.done || 0}/${c.imageCount} 张)` : ''}${c.pdf?.pages ? ` · ${c.pdf.pages} 页` : ''}` : '';
  return `<div>${String(c.number).padStart(3,'0')} · ${escape(c.title)} — ${labels[c.status] || c.status} (${c.imageCount} 张)${pdf} ${escape(c.error)} ${escape(c.pdf?.error)}${c.pdf?.status === 'completed' ? ` <a class="pdf-link" href="${pdfLink(j,c)}" target="_blank" rel="noopener noreferrer">打开 PDF ↗</a>` : ''}</div>`;
}
$('generatePdf').addEventListener('change', () => { $('splitLongImages').disabled = outputLocked || !$('generatePdf').checked; });
let refreshing = false;
async function refresh() {
  if (refreshing || !backendConnected) return; refreshing = true;
  const revision = sourceRevision, requestedJobId = currentJobId;
  try {
    const allJobs = await api('/api/jobs');
    if (revision !== sourceRevision || requestedJobId !== currentJobId) return;
    let current = allJobs.find(j => j.id === currentJobId);
    if (!current && restoreJobOnLoad) {
      current = allJobs.find(j => ['queued', 'running', 'paused', 'interrupted'].includes(j.status));
      currentJobId = current?.id || null;
      if (currentJobId) sessionStorage.setItem('currentDownloadId', currentJobId);
      else sessionStorage.removeItem('currentDownloadId');
    }
    if (current && detachedJob && !['queued', 'running', 'paused'].includes(current.status)) {
      current = undefined; currentJobId = null; sessionStorage.removeItem('currentDownloadId');
    }
    restoreJobOnLoad = false; currentJobStatus = current?.status || '';
    $('downloadPanel').classList.toggle('hidden', !current);
    if (!current) { $('jobs').innerHTML = ''; return; }
    const jobs = [current];
    // Retain focused controls while updating progress.
    const focused = document.activeElement?.dataset;
    const openDetails = new Set([...document.querySelectorAll('.job details[open]')].map(d => d.closest('.job').querySelector('[data-id]').dataset.id));
    $('jobs').innerHTML = jobs.map(j => {
      const pdfDone = j.chapters.filter(c => c.pdf?.status === 'completed').length;
      const pdfFailed = j.chapters.filter(c => c.pdf?.status === 'failed').length;
      const firstPdf = j.chapters.find(c => c.pdf?.status === 'completed');
      const percent = j.total ? Math.round(j.done / j.total * (j.generatePdf ? 80 : 100) + (j.generatePdf ? pdfDone / j.chapters.length * 20 : 0)) : 0;
      const active = ['running','queued','paused'].includes(j.status);
      return `<article class="job"><div class="job-top"><strong>${escape(j.title)}</strong><span class="status ${j.status}">${labels[j.status]}</span></div><div class="progress"><i style="width:${percent}%"></i></div><div class="job-message">${escape(j.message)}</div><div class="stats"><span>并发 <b>${j.chapterConcurrency || 1} 章</b></span><span>章节 <b>${j.chapters.filter(c=>c.status==='completed').length} / ${j.chapters.length}</b></span><span>图片 <b>${j.done} / ${j.total}</b></span><span>失败 <b>${j.failed}</b></span>${j.generatePdf ? `<span>PDF <b>${pdfDone} / ${j.chapters.length}</b>${pdfFailed ? ` · 失败 ${pdfFailed}` : ''}</span>` : ''}</div><div class="job-actions">${['running','queued'].includes(j.status)?`<button data-id="${j.id}" data-action="pause">暂停</button>`:''}${!['running','queued','completed'].includes(j.status)?`<button data-id="${j.id}" data-action="resume">${['partial','failed'].includes(j.status)?'重试失败项':'继续下载'}</button>`:''}${active?`<button data-id="${j.id}" data-action="stop">停止</button>`:''}${pdfFailed && !active ? `<button data-id="${j.id}" data-action="retry-pdf">重试 PDF</button>` : ''}${firstPdf ? `<a class="pdf-link" href="${pdfLink(j,firstPdf)}" target="_blank" rel="noopener noreferrer">打开章节 PDF ↗</a>` : ''}<button data-id="${j.id}" data-action="open">打开文件夹 ↗</button></div><div class="job-path">${escape(j.output)}</div><details class="chapter-status" ${openDetails.has(j.id)?'open':''}><summary>${j.generatePdf ? '查看章节与 PDF' : '查看章节状态'}</summary>${j.chapters.map(c => chapterStatus(j,c)).join('')}</details></article>`;
    }).join('');
    if(focused?.action) document.querySelector(`[data-id="${focused.id}"][data-action="${focused.action}"]`)?.focus();
  } catch(e) { if (revision === sourceRevision && requestedJobId === currentJobId) notice('服务连接失败：' + e.message, true); } finally { refreshing = false; }
}
$('jobs').onclick = async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  b.disabled = true; try { const r = await api(`/api/jobs/${b.dataset.id}/${b.dataset.action}`,{}); if(b.dataset.action === 'open') notice('保存位置：' + r.path); await refresh(); } catch(e) { notice(e.message,true); } finally { b.disabled = false; }
};
if (!hosted) loadDownloadDefaults().catch(() => notice('请重启最新版的本机程序，以启用系统下载目录和目录选择功能。', true));
refresh(); setInterval(() => { refresh(); refreshLocalPdf(); }, 1800);

$('demo').onclick = () => { $('url').value = backendBase + '/demo/'; sourceChanged(); rulesUrl = ''; $('mode').value = 'auto'; $('parse').click(); };

for (const id of ['chapterSelector','imageSelector','nextSelector','minWidth','minHeight','followPages','mode']) {
  $(id).addEventListener('change', clearPreview);
}


// Independent local converter: no website or download task is needed.
let localImages = [], localRevision = 0, localPdfBusy = false, localPdfWorking = false, localPdfPolling = false;
let localPdfId = sessionStorage.getItem('currentLocalPdfId');
const intro = ['.intro h1','.intro p','.flow','.eyebrow','.small-note'].map(selector => document.querySelector(selector));
const originalIntro = intro.map(el => el.innerHTML);
function selectTool(local) {
  $('collectorTool').classList.toggle('hidden',local); $('localPdfTool').classList.toggle('hidden',!local);
  $('showCollector').setAttribute('aria-pressed',String(!local)); $('showLocalPdf').setAttribute('aria-pressed',String(local));
  const text = ['本地图片，<br>一键成册<span>。</span>','选择图片、确认顺序，直接生成 PDF。<br>无需网址，原始图片保持不变。','<span>01 选择图片</span><b>→</b><span>02 确认顺序</span><b>→</b><span>03 生成 PDF</span>','让图片，变成一本书','支持常见图片格式与长图分页<br>图片读取和 PDF 生成均在本机完成'];
  intro.forEach((el,i) => el.innerHTML = local ? text[i] : originalIntro[i]);
  if (typeof history !== 'undefined') history.replaceState(null,'',local?'#pdf':location.pathname || './');
}
$('showCollector').onclick = () => selectTool(false); $('showLocalPdf').onclick = () => selectTool(true);
if (location.hash === '#pdf') selectTool(true);
function localNotice(message,error=false) { $('localPdfNotice').textContent=message; $('localPdfNotice').classList.toggle('error',error); }
function localLocks() {
  for (const id of ['localPdfScan','localPdfPickSource','localPdfPickOutput','localPdfStart','localPdfReverse']) $(id).disabled=localPdfBusy||localPdfWorking;
  for (const id of ['localPdfSource','localPdfName','localPdfDirectory']) $(id).readOnly=localPdfWorking||localPdfBusy;
  for (const id of ['localPdfSplit','localPdfAll']) $(id).disabled=localPdfWorking||localPdfBusy;
}
function clearLocalResult() {
  if(localPdfWorking)return;
  localPdfId=null;sessionStorage.removeItem('currentLocalPdfId');$('localPdfResult').innerHTML='';$('localPdfResult').classList.add('hidden');
}
function clearLocalSource() {
  if(localPdfWorking)return;
  localRevision++;localImages=[];$('localPdfSettings').classList.add('hidden');$('localPdfFiles').innerHTML='';$('localPdfName').value='';clearLocalResult();
  localNotice('图片文件夹已更换，请读取图片。');
}
$('localPdfSource').addEventListener('input',clearLocalSource);
for(const id of ['localPdfName','localPdfDirectory','localPdfSplit']) $(id).addEventListener('input',clearLocalResult);
async function localAction(fn) {
  if(localPdfBusy||localPdfWorking)return;
  localPdfBusy=true;localLocks();
  try{await fn();}catch(e){localNotice(e.message,true);}finally{localPdfBusy=false;localLocks();}
}
function localSelected() {
  $('localPdfCount').textContent=`已选 ${localImages.filter(i=>i.selected).length} / ${localImages.length} 张`;
  $('localPdfAll').checked=localImages.length>0&&localImages.every(i=>i.selected);
  $('localPdfAll').indeterminate=localImages.some(i=>i.selected)&&!localImages.every(i=>i.selected);
}
function renderLocalImages() {
  $('localPdfFiles').innerHTML=localImages.map((item,i)=>`<div class="local-image"><input aria-label="选择 ${escape(item.name)}" type="checkbox" data-local-index="${i}" ${item.selected?'checked':''} ${localPdfWorking?'disabled':''}><span class="number">${String(i+1).padStart(3,'0')}</span><span class="filename" title="${escape(item.name)}">${escape(item.name)}</span><button data-move="-1" data-local-index="${i}" aria-label="上移 ${escape(item.name)}" ${i===0||localPdfWorking?'disabled':''}>↑</button><button data-move="1" data-local-index="${i}" aria-label="下移 ${escape(item.name)}" ${i===localImages.length-1||localPdfWorking?'disabled':''}>↓</button></div>`).join('');localSelected();
}
$('localPdfFiles').onchange=e=>{if(localPdfWorking||localPdfBusy||e.target.dataset.localIndex===undefined)return;localImages[Number(e.target.dataset.localIndex)].selected=e.target.checked;clearLocalResult();localSelected();};
$('localPdfFiles').onclick=e=>{
  if(localPdfWorking||localPdfBusy)return;const b=e.target.closest('button[data-move]');if(!b)return;const i=Number(b.dataset.localIndex),next=i+Number(b.dataset.move);
  if(next<0||next>=localImages.length)return;[localImages[i],localImages[next]]=[localImages[next],localImages[i]];clearLocalResult();renderLocalImages();
};
$('localPdfAll').onchange=()=>{if(localPdfWorking)return;localImages.forEach(i=>i.selected=$('localPdfAll').checked);clearLocalResult();renderLocalImages();};
$('localPdfReverse').onclick=()=>{if(localPdfWorking)return;localImages.reverse();clearLocalResult();renderLocalImages();};
async function scanLocalImages() {
  const revision=localRevision,source=$('localPdfSource').value.trim();
  localNotice('正在读取图片列表…');let result;
  try{result=await api('/api/local-images',{source});}catch(e){if(revision===localRevision&&source===$('localPdfSource').value.trim())throw e;return;}
  if(revision!==localRevision||source!==$('localPdfSource').value.trim())return;
  localImages=result.files.map(f=>({...f,selected:true}));$('localPdfSource').value=result.directory;$('localPdfName').value=result.name;
  $('localPdfSettings').classList.remove('hidden');renderLocalImages();localNotice(`已读取 ${localImages.length} 张图片，请确认顺序和保存位置。`);
}
$('localPdfScan').onclick=()=>localAction(async()=>{clearLocalResult();localRevision++;localImages=[];$('localPdfSettings').classList.add('hidden');await scanLocalImages();});
$('localPdfPickSource').onclick=()=>localAction(async()=>{
  localNotice('请在系统窗口中选择直接包含图片的文件夹…');const result=await api('/api/choose-directory',{});
  if(!result.directory){localNotice('已取消选择。');return;}$('localPdfSource').value=result.directory;clearLocalSource();await scanLocalImages();
});
$('localPdfPickOutput').onclick=()=>localAction(async()=>{const result=await api('/api/choose-directory',{});if(result.directory){clearLocalResult();$('localPdfDirectory').value=result.directory;}});
$('localPdfStart').onclick=()=>localAction(async()=>{
  const files=localImages.filter(i=>i.selected).map(i=>i.name);if(!files.length)throw new Error('请先读取并选择图片');
  const revision=localRevision;const task=await api('/api/conversions',{source:$('localPdfSource').value.trim(),directory:$('localPdfDirectory').value.trim(),name:$('localPdfName').value,files,splitLongImages:$('localPdfSplit').checked});
  if(revision!==localRevision)return;localPdfId=task.id;sessionStorage.setItem('currentLocalPdfId',task.id);renderLocalTask(task);renderLocalImages();
});
function renderLocalTask(task) {
  const wasWorking=localPdfWorking;localPdfWorking=['queued','generating','stopping'].includes(task.status);localLocks();
  if(wasWorking!==localPdfWorking)renderLocalImages();
  const names={queued:'等待生成',generating:'正在生成 PDF',completed:'转换完成',failed:'转换失败',stopped:'已取消',stopping:'正在取消'};
  $('localPdfResult').classList.remove('hidden');
  $('localPdfResult').innerHTML=`<div class="job-top"><strong>${escape(task.name)}</strong><span class="status ${task.status}">${names[task.status]||task.status}</span></div><div class="progress"><i style="width:${task.status==='completed'?100:Math.round(task.done/task.total*95)}%"></i></div><div class="job-message">已处理 ${task.done} / ${task.total} 张图片 · ${task.pages} 页</div><div class="job-path">${escape(task.output)}</div>${task.error?`<div class="notice error">${escape(task.error)}</div>`:''}<div class="job-actions">${localPdfWorking?'<button data-local-action="stop">取消转换</button>':''}${task.status==='completed'?`<a class="pdf-link" target="_blank" rel="noopener noreferrer" href="${backendBase}/api/conversions/${encodeURIComponent(task.id)}/pdf">打开 PDF ↗</a><button data-local-action="open">打开所在目录 ↗</button>`:''}</div>`;
  localNotice(task.status==='completed'?'PDF 已生成，原始图片保持不变。':task.status==='failed'?'转换失败，可检查图片或修改设置后重新生成。':task.status==='queued'?'已加入 PDF 生成队列，请稍候…':names[task.status]||'正在转换…');
}
async function refreshLocalPdf() {
  if(!localPdfId||!backendConnected||localPdfPolling)return;localPdfPolling=true;const id=localPdfId,revision=localRevision;
  try{const task=await api(`/api/conversions/${encodeURIComponent(id)}`);if(id===localPdfId&&revision===localRevision)renderLocalTask(task);}
  catch(e){if(id===localPdfId&&revision===localRevision){localPdfWorking=false;clearLocalResult();localLocks();localNotice('无法读取转换状态，请重新选择图片或重启最新版本机程序。',true);}}
  finally{localPdfPolling=false;}
}
$('localPdfResult').onclick=async e=>{
  const b=e.target.closest('button[data-local-action]');if(!b||!localPdfId)return;b.disabled=true;
  try{const task=await api(`/api/conversions/${encodeURIComponent(localPdfId)}/${b.dataset.localAction}`,{});if(b.dataset.localAction==='stop')renderLocalTask(task);else localNotice('PDF 保存目录：'+task.path);}catch(e){localNotice(e.message,true);}finally{b.disabled=false;}
};
refreshLocalPdf();
