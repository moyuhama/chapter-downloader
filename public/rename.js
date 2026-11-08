const $=id=>document.getElementById(id);
const base=['127.0.0.1','localhost','[::1]'].includes(location.hostname)?location.origin:'http://127.0.0.1:3789';
let plan=null,rows=[],revision=0,busy=false,finished=false,ready=false;
const nameKey=name=>name.normalize('NFC').toLowerCase();
function message(text,error=false){$('renameNotice').textContent=text;$('renameNotice').classList.toggle('error',error);}
async function api(route,data){
  let r;try{r=await fetch(base+route,data===undefined?{signal:AbortSignal.timeout(5000)}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch{throw new Error('无法连接本机助手，请返回首页启动并连接。');}
  let value;try{value=await r.json();}catch{throw new Error('请更新本机助手后再使用此工具。');}
  if(!r.ok)throw new Error(r.status===404?'请更新本机助手后再使用此工具。':value.error||'操作失败');return value;
}
function locks(){for(const id of ['renamePick','renamePreview'])$(id).disabled=busy||!ready;$('renameSource').readOnly=busy;$('renameAll').disabled=busy||finished;for(const row of rows){row.check.disabled=busy||finished;row.input.readOnly=busy||finished;}validate();}
function invalidate(){if(busy)return;++revision;plan=null;rows=[];finished=false;$('renameResults').classList.add('hidden');message('目录已更改，请重新预览。');}
$('renameSource').addEventListener('input',invalidate);
function validate(){
  const selected=rows.filter(r=>r.check.checked);const counts=new Map();const errors=[];const occupied=new Set((plan?.existing||[]).map(nameKey));
  for(const row of selected){const target=row.input.value;counts.set(nameKey(target),(counts.get(nameKey(target))||0)+1);}
  for(const row of rows){let problem='';const target=row.input.value;
    if(row.check.checked&&!finished){
      if(!target.trim()||target!==target.trim()||/[<>:"/\\|?*\x00-\x1f]/.test(target)||/[. ]$/.test(target)||target==='.'||target==='..')problem='请输入有效的文件夹名';
      else if(target===row.from)problem='名称没有变化，请取消勾选';
      else if(counts.get(nameKey(target))>1)problem='目标编号重复，请修改或取消勾选';
      else if(occupied.has(nameKey(target)))problem='目标名称已存在';
      if(problem)errors.push(problem);
    }
    row.status.textContent=finished?row.result:problem||(row.check.checked?'待改名':row.to===row.from?'名称已符合':row.reason||'未勾选');row.element.classList.toggle('rename-invalid',!!problem);
  }
  $('renameSelected').textContent=`已选 ${selected.length} / ${rows.length} 个`;
  const selectable=rows.filter(r=>r.to&&r.to!==r.from);$('renameAll').checked=selectable.length>0&&selectable.every(r=>r.check.checked);$('renameAll').indeterminate=selectable.some(r=>r.check.checked)&&!$('renameAll').checked;
  $('renameConflict').classList.toggle('hidden',!errors.length);$('renameConflict').textContent=errors.length?'存在冲突：请调整标出的目录后再执行。':'';
  $('renameApply').disabled=busy||finished||!selected.length||!!errors.length||!plan;
}
function render(value){
  plan=value;rows=[];finished=false;$('renameRows').replaceChildren();$('renameCount').textContent=`${value.rows.length} 个子文件夹`;$('renameSummary').textContent='尚未改动任何文件夹';
  for(const row of value.rows){
    const element=document.createElement('div');element.className='rename-row';const check=document.createElement('input');check.type='checkbox';check.checked=row.selected;check.setAttribute('aria-label',`选择 ${row.from}`);
    const names=document.createElement('div');names.className='rename-names';const from=document.createElement('span');from.className='rename-from';from.textContent=row.from;const field=document.createElement('label');field.textContent='改为';const input=document.createElement('input');input.value=row.to;input.setAttribute('aria-label',`${row.from} 的新名称`);field.append(input);names.append(from,field);
    const status=document.createElement('span');status.className='rename-status';element.append(check,names,status);$('renameRows').append(element);rows.push({...row,element,check,input,status,result:''});check.onchange=validate;input.oninput=()=>{if(!check.checked&&input.value)check.checked=true;validate();};
  }
  $('renameResults').classList.remove('hidden');locks();
}
$('renameAll').onchange=()=>{const checked=$('renameAll').checked;for(const row of rows)if(row.to&&row.to!==row.from)row.check.checked=checked;validate();};
$('renamePick').onclick=async()=>{busy=true;locks();try{const r=await api('/api/choose-directory',{});if(r.directory){busy=false;$('renameSource').value=r.directory;invalidate();}}catch(e){message(e.message,true);}finally{busy=false;locks();}};
$('renamePreview').onclick=async()=>{
  const current=++revision;busy=true;plan=null;rows=[];finished=false;$('renameResults').classList.add('hidden');locks();message('正在读取子文件夹…');
  try{const result=await api('/api/rename/preview',{source:$('renameSource').value});if(current!==revision)return;render(result);message('预览已生成，请核对后点击执行。');}catch(e){if(current===revision)message(e.message,true);}finally{busy=false;locks();}
};
$('renameApply').onclick=async()=>{
  if(busy||!plan||finished)return;const changes=rows.filter(r=>r.check.checked).map(r=>({id:r.id,to:r.input.value}));
  busy=true;locks();message('正在批量重命名，请勿关闭本机助手…');
  try{
    const result=await api('/api/rename/apply',{id:plan.id,changes});finished=true;
    for(const row of rows){const item=result.rows.find(r=>r.from===row.from);row.result=item?.status==='renamed'?`已改为 ${item.to}`:'未改动';}
    $('renameSummary').textContent=`已改名 ${result.changed} 个，其余保持原样`;
    message(result.ok?`完成：已重命名 ${result.changed} 个文件夹。${result.warning||''}`:`${result.error}。${(result.issues||[]).join('；')}。请根据下方结果检查文件夹。`,!result.ok);
  }catch(e){message(e.message+'；请重新预览后再执行。',true);plan=null;}
  finally{busy=false;locks();}
};
async function init(){try{const health=await api('/api/health');if(!health.capabilities?.folderRename)throw new Error('批量改名需要新版本机助手，请下载安装最新版后再使用。');ready=true;$('renameBackend').textContent='本机助手已连接';message('选择父目录，预览下一层章节文件夹的改名结果。');}catch(e){$('renameBackend').textContent='需要连接新版助手';$('renameUpdate').classList.remove('hidden');message(e.message,true);}locks();}
init();
