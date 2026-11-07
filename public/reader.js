const $=id=>document.getElementById(id);
const fragment=new URLSearchParams(location.hash.slice(1));
let token=fragment.get('share')||sessionStorage.getItem('shiye-reader-token')||'';
const shared=!!token;
if(token){sessionStorage.setItem('shiye-reader-token',token);history.replaceState(null,'',location.pathname);}
const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const base=shared||local?location.origin:'http://127.0.0.1:3789';
let book=null,chapter=0,index=0,epoch=0,loading=false,appending=false,frames=[],loaded=[],chapterCache=new Map(),share=null,activeButton=null,scrollFrame=0;
const stored=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const store=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const positionKey=()=>`shiye-reader-position:${book.id}`;
const preferences=stored('shiye-reader-preferences',{});
$('mode').value=preferences.mode==='page'?'page':'scroll';
$('width').value=['760px','1000px','100%'].includes(preferences.width)?preferences.width:'760px';
$('autoNext').checked=preferences.autoNext!==false;
function applyPreferences(){document.documentElement.style.setProperty('--reader-width',$('width').value);document.body.classList.toggle('single',$('mode').value==='page');store('shiye-reader-preferences',{mode:$('mode').value,width:$('width').value,autoNext:$('autoNext').checked});}
applyPreferences();
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function api(route,data) {
  let r;
  try{r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(30000)});}
  catch{throw new Error(shared?'无法连接电脑，请确认同一 Wi-Fi、电脑未休眠且助手仍在运行。':'无法连接本机助手。请返回首页启动并连接；阅读器需要新版助手。');}
  let result;try{result=await r.json();}catch{throw new Error('助手版本不支持阅读器，请下载安装最新版助手。');}
  if(!r.ok)throw new Error(r.status===404&&!shared?'请更新本机助手，以使用阅读器。':result.error||'读取失败');return result;
}
function syncSidebar(){ $('sidebar').inert=matchMedia('(max-width:700px)').matches&&!$('sidebar').classList.contains('open'); }
window.addEventListener('resize',syncSidebar);syncSidebar();
function menu(open){$('sidebar').classList.toggle('open',open);syncSidebar();$('shade').classList.toggle('hidden',!open);$('menu').setAttribute('aria-expanded',String(open));if(open)$('closeMenu').focus();}
$('menu').onclick=()=>menu(!$('sidebar').classList.contains('open'));
$('closeMenu').onclick=()=>{menu(false);$('menu').focus();};$('shade').onclick=()=>menu(false);
$('settingsToggle').onclick=()=>{const open=$('settings').classList.toggle('hidden');$('settingsToggle').setAttribute('aria-expanded',String(!open));};
function updateControls(){
  if(!book)return;const single=$('mode').value==='page';
  $('chapterTitle').textContent=book.chapters[chapter]?.title||'';
  $('progress').textContent=`${chapter+1} / ${book.chapters.length} 章 · ${index+1} / ${book.chapters[chapter]?.count||0} 页`;
  $('prev').textContent=single?'← 上一页':'← 上一章';$('next').textContent=single?'下一页 →':'下一章 →';
  $('prev').disabled=loading||(chapter===0&&(!single||index===0));
  $('next').disabled=loading||(chapter===book.chapters.length-1&&(!single||index>=book.chapters[chapter].count-1));
  if(activeButton?.dataset.chapter!==String(chapter)){activeButton?.removeAttribute('aria-current');activeButton=$('chapters').querySelector(`[data-chapter="${chapter}"]`);activeButton?.setAttribute('aria-current','true');}
}
function remember(fraction=0){if(book)store(positionKey(),{chapter,index,fraction});}
async function chapterData(id){const key=`${book.id}:${id}`;if(!chapterCache.has(key))chapterCache.set(key,api(`/api/reader/chapter/${id}?book=${book.id}`).catch(e=>{chapterCache.delete(key);throw e;}));return chapterCache.get(key);}
function figure(image,id,eager=false){
  const f=document.createElement('figure');f.className='page';f.dataset.chapter=id;f.dataset.index=image.index;
  const img=document.createElement('img');img.alt=`${book.chapters[id].title} · 第 ${image.index+1} 页`;img.width=image.width||800;img.height=image.height||1100;img.loading=eager?'eager':'lazy';img.decoding='async';
  const url=new URL(`${base}/api/reader/image/${id}/${image.index}`);url.searchParams.set('book',book.id);if(token)url.searchParams.set('token',token);img.src=url.href;
  img.onerror=()=>{if(f.querySelector('figcaption'))return;img.classList.add('hidden');const caption=document.createElement('figcaption');caption.textContent=`第 ${image.index+1} 页读取失败。`;const retry=document.createElement('button');retry.textContent='重试图片';retry.onclick=e=>{e.stopPropagation();caption.remove();img.classList.remove('hidden');img.src=url.href+'&retry='+Date.now();};caption.append(retry);f.append(caption);};
  f.append(img);f.onclick=()=>{document.body.classList.toggle('quiet');$('settings').classList.add('hidden');$('settingsToggle').setAttribute('aria-expanded','false');};return f;
}
function addChapter(data,start=0){
  const section=document.createElement('section');section.dataset.chapterSection=data.id;
  const title=document.createElement('div');title.className='chapter-break';title.textContent=data.title;const count=document.createElement('small');count.textContent=`${data.images.length} 页`;title.append(count);section.append(title);
  for(const image of data.images)section.append(figure(image,data.id,image.index===start));
  $('pages').append(section);loaded.push(data.id);frames=[...$('pages').querySelectorAll('.page')];
}
function endState(){const last=loaded.at(-1)??chapter;const hasNext=last<book.chapters.length-1;$('end').classList.toggle('hidden',$('mode').value==='page');$('endText').textContent=hasNext?'这一章读完了，下一章就在下面。':'已读到这部作品的最后一页。';$('loadNext').classList.toggle('hidden',!hasNext);$('loadNext').disabled=appending;}
async function navigate(id,page=0,fraction=0){
  if(!book||!book.chapters[id])return;const request=++epoch;loading=true;updateControls();notice('正在读取章节…');
  try{
    const data=await chapterData(id);if(request!==epoch)return;
    chapter=id;index=Math.max(0,Math.min(data.images.length-1,Number(page)||0));
    $('pages').replaceChildren();loaded=[];frames=[];
    if($('mode').value==='page'){const f=figure(data.images[index],id,true);$('pages').append(f);frames=[f];loaded=[id];window.scrollTo(0,0);}
    else {addChapter(data,index);const f=frames[index];const top=f.getBoundingClientRect().top+window.scrollY;window.scrollTo(0,Math.max(0,top+f.getBoundingClientRect().height*Math.min(.99,Math.max(0,Number(fraction)||0))-82));}
    $('welcome').classList.add('hidden');$('readerBar').classList.remove('hidden');notice('');remember(fraction);endState();
  }catch(e){if(request===epoch)notice(e.message,true);}
  finally{if(request===epoch){loading=false;updateControls();}}
}
async function appendNext(){
  if(!book||loading||appending||$('mode').value!=='scroll'||!loaded.length)return;
  const id=loaded.at(-1)+1;if(!book.chapters[id])return;
  const request=epoch;appending=true;endState();
  try{const data=await chapterData(id);if(request!==epoch)return;addChapter(data);endState();}
  catch(e){if(request===epoch)notice(e.message,true);}
  finally{appending=false;if(book)endState();}
}
async function turn(direction){
  if(!book||loading)return;
  if($('mode').value==='scroll')return navigate(chapter+direction);
  const next=index+direction;
  if(next<0){if(chapter>0)return navigate(chapter-1,book.chapters[chapter-1].count-1);}
  else if(next>=book.chapters[chapter].count){if(chapter<book.chapters.length-1)return navigate(chapter+1);}
  else return navigate(chapter,next);
}
$('prev').onclick=()=>turn(-1);$('next').onclick=()=>turn(1);$('loadNext').onclick=appendNext;
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){menu(false);$('settings').classList.add('hidden');$('settingsToggle').setAttribute('aria-expanded','false');document.body.classList.remove('quiet');return;}
  if(e.target.matches('input,select,textarea')||document.querySelector('dialog[open]'))return;
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();turn(e.key==='ArrowLeft'?-1:1);}
});
window.addEventListener('scroll',()=>{
  if(scrollFrame||loading||!book||$('mode').value!=='scroll'||!frames.length)return;
  scrollFrame=requestAnimationFrame(()=>{
    scrollFrame=0;let left=0,right=frames.length-1,result=0;
    while(left<=right){const middle=(left+right)>>1;if(frames[middle].getBoundingClientRect().top<=100){result=middle;left=middle+1;}else right=middle-1;}
    const frame=frames[result],rect=frame.getBoundingClientRect();chapter=Number(frame.dataset.chapter);index=Number(frame.dataset.index);remember(Math.max(0,Math.min(.99,(82-rect.top)/Math.max(1,rect.height))));updateControls();
  });
},{passive:true});
const nextObserver=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&$('autoNext').checked)appendNext();},{rootMargin:'300px'});nextObserver.observe($('end'));
$('autoNext').onchange=()=>{applyPreferences();if($('autoNext').checked&&$('end').getBoundingClientRect().top<innerHeight+300)appendNext();};
$('width').onchange=()=>{applyPreferences();};$('mode').onchange=()=>{applyPreferences();if(book)navigate(chapter,index);};
function renderBook(value){
  book=value;chapterCache.clear();activeButton=null;$('chapters').replaceChildren();
  $('bookTitle').textContent=book.title;document.title=book.title+' · 拾页阅读器';$('bookSummary').textContent=`${book.chapters.length} 章 · ${book.total} 页`;
  for(const c of book.chapters){const button=document.createElement('button');button.dataset.chapter=c.id;button.textContent=c.title;const small=document.createElement('small');small.textContent=`${c.count} 页`;button.append(small);button.onclick=()=>{menu(false);if(matchMedia('(max-width:700px)').matches)$('menu').focus();document.body.classList.remove('quiet');navigate(c.id);};$('chapters').append(button);}
}
async function useBook(value){if(!value)return;renderBook(value);const saved=stored(positionKey(),{});await navigate(Math.min(book.chapters.length-1,Math.max(0,Number(saved.chapter)||0)),saved.index,saved.fraction);}
async function openDialog(){
  $('openError').textContent='';$('openDialog').showModal();
  try{const result=await api('/api/reader/source');if(!$('source').value)$('source').value=result.source||'';}catch{}
}
$('welcomeOpen').onclick=openDialog;$('changeBook').onclick=openDialog;$('closeOpen').onclick=()=>$('openDialog').close();
$('pick').onclick=async()=>{try{$('pick').disabled=true;const r=await api('/api/choose-directory',{});if(r.directory)$('source').value=r.directory;}catch(e){$('openError').textContent=e.message;}finally{$('pick').disabled=false;}};
$('openForm').onsubmit=async e=>{e.preventDefault();$('openBook').disabled=true;$('openError').textContent='';try{const value=await api('/api/reader/open',{source:$('source').value});++epoch;await useBook(value);$('openDialog').close();menu(false);}catch(e){$('openError').textContent=e.message;}finally{$('openBook').disabled=false;}};
function renderShare(value){
  share=value;$('shareInfo').classList.toggle('hidden',!value.enabled);$('enableShare').classList.toggle('hidden',value.enabled);$('disableShare').classList.toggle('hidden',!value.enabled);
  if(value.enabled){$('qr').classList.remove('hidden');$('qr').src=value.qr;$('shareAddress').replaceChildren();for(const url of value.urls){const option=document.createElement('option');option.value=url;option.textContent=new URL(url).host;$('shareAddress').append(option);}$('shareUrl').value=value.urls[0];}
}
$('shareToggle').onclick=async()=>{$('shareDialog').showModal();$('shareError').textContent='';try{renderShare(await api('/api/reader/share'));}catch(e){$('shareError').textContent=e.message;}};
$('closeShare').onclick=()=>$('shareDialog').close();
$('enableShare').onclick=async()=>{$('enableShare').disabled=true;try{renderShare(await api('/api/reader/share',{enabled:true}));$('shareError').textContent='';}catch(e){$('shareError').textContent=e.message;}finally{$('enableShare').disabled=false;}};
$('disableShare').onclick=async()=>{$('disableShare').disabled=true;try{renderShare(await api('/api/reader/share',{enabled:false}));}catch(e){$('shareError').textContent=e.message;}finally{$('disableShare').disabled=false;}};
$('shareAddress').onchange=()=>{$('shareUrl').value=$('shareAddress').value;$('qr').classList.toggle('hidden',$('shareAddress').selectedIndex!==0);};
$('copyShare').onclick=async()=>{try{await navigator.clipboard.writeText($('shareUrl').value);$('shareError').textContent='地址已复制';}catch{$('shareUrl').select();$('shareError').textContent='请复制上方已选中的地址';}};
if(shared){$('desktopActions').classList.add('hidden');$('welcomeOpen').classList.add('hidden');$('back').removeAttribute('href');$('back').textContent='拾页';$('welcome').querySelector('p').textContent='正在连接电脑上的作品…';}
async function init(){
  try{
    if(!shared){const health=await api('/api/health');if(!health.capabilities?.reader)throw new Error('阅读器需要新版本机助手。请返回首页下载最新版，解压并双击打开后再回来。');}
    const job=fragment.get('job');const value=job&&!shared?await api('/api/reader/open',{jobId:job}):await api('/api/reader/book');
    if(job&&!shared)history.replaceState(null,'',location.pathname);
    if(value)await useBook(value);else if(shared)notice('电脑尚未打开作品，请先在电脑选择作品文件夹。',true);
  }catch(e){notice(e.message,true);if(!shared)$('updateHelper').classList.remove('hidden');}
}
init();
