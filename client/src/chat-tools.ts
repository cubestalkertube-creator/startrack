type Message = { id:number; sender:number; text:string; kind?:string|null; file?:{name:string;type:string}|null; reply?:{id:number;sender?:number;name?:string;text:string;deleted?:boolean}|null };
type Conv = {key:string;to:Record<string,number>;name:string};
type Options = {
  api(path:string,body?:unknown):Promise<any>; me():number; conv():Conv|null; messages():Message[];
  name(id:number):string; esc(s:string):string; icon(name:string,size?:number):string; toast(s:string):void;
  server():string; token():string; upload(c:Conv,file:File,opts?:{reply?:number;media?:string;duration?:number}):void;
  onRead(key:string):void;
};
let O:Options;
const replies = new Map<string,Message>();
const reads = new Map<string,Map<number,number>>();
const acknowledged = new Map<string,number>();
let observer:IntersectionObserver|null=null, readTimer=0, recordCancel:(()=>void)|null=null, picker:HTMLElement|null=null;
export function initChatTools(o:Options) { O=o; }
export function resetChatTools() { recordCancel?.(); picker?.remove(); replies.clear(); reads.clear(); acknowledged.clear(); observer?.disconnect(); }
export function stopComposerTools(){recordCancel?.();observer?.disconnect();}
export const replyId = (key:string) => replies.get(key)?.id;
export function clearReply(key:string) { replies.delete(key); drawReply(); }
function drawReply() {
  const bar=document.getElementById('reply-bar'), c=O.conv(), m=c && replies.get(c.key);
  if(!bar) return;
  bar.hidden=!m;
  bar.innerHTML=m ? `<span>Ответ для <b>${O.esc(O.name(m.sender))}</b><small>${O.esc(m.text || m.file?.name || 'Вложение')}</small></span><button type="button" class="ibtn" aria-label="Отменить ответ">${O.icon('close',18)}</button>` : '';
  bar.querySelector('button')?.addEventListener('click',()=>c && clearReply(c.key));
}
export function replyMarkup(m:Message) {
  const r=m.reply;
  return r ? `<button type="button" class="msg-quote" data-reply-target="${r.id}" title="Перейти к сообщению">↳ <b>${O.esc(r.deleted ? '' : r.sender ? O.name(r.sender) || r.name || '' : r.name || '')}</b><span>${O.esc(r.text.slice(0,180))}</span></button>` : '';
}
export function messageTools(m:Message) {
  return `<div class="msg-tools"><button type="button" data-msg-action="reply" title="Ответить" aria-label="Ответить">↩</button><button type="button" data-msg-action="menu" title="Действия с сообщением" aria-label="Действия с сообщением">⋯</button></div>`;
}
export function receiptMarkup(m:Message) {
  return m.sender===O.me() ? `<span class="msg-receipt" data-read-id="${m.id}" aria-label="Отправлено" title="Отправлено">✓</span>` : '';
}
export function drawReceipts() {
  const c=O.conv(); if(!c) return;
  document.querySelectorAll<HTMLElement>('[data-read-id]').forEach(el=>{
    const ids=[...(reads.get(c.key) || [])].filter(([uid,last])=>uid!==O.me() && last>=Number(el.dataset.readId)).map(([uid])=>uid);
    const label=ids.length ? `Прочитано: ${ids.map(O.name).join(', ')}` : 'Отправлено, ещё не прочитано';
    el.textContent=ids.length ? '✓✓' : '✓'; el.title=label; el.setAttribute('aria-label',label); el.classList.toggle('read',!!ids.length);
  });
}
export function readEvent(e:{user:number;id:number;group?:number;a:number;b:number}) {
  const key=e.group ? 'g'+e.group : 'u'+(e.a===O.me()?e.b:e.a);
  if(!reads.has(key)) reads.set(key,new Map());
  reads.get(key)!.set(e.user,Math.max(reads.get(key)!.get(e.user)||0,e.id));
  if(e.user===O.me()) {acknowledged.set(key,Math.max(acknowledged.get(key)||0,e.id));O.onRead(key);}
  drawReceipts();
}
export async function loadReads(c:Conv) {
  try {
    const rows:{uid:number;last:number}[]=await O.api('/api/messages/reads?'+new URLSearchParams(Object.entries(c.to).map(([k,v])=>[k,String(v)])));
    const current=reads.get(c.key)||new Map<number,number>();
    for(const r of rows) current.set(r.uid,Math.max(current.get(r.uid)||0,r.last));
    reads.set(c.key,current); drawReceipts(); observeMessages();
  } catch {}
}
function markVisible() {
  const c=O.conv(), box=document.getElementById('msgs');
  if(!c || !box || document.hidden || !document.hasFocus() || !box.getClientRects().length) return;
  const bounds=box.getBoundingClientRect(); let id=0;
  box.querySelectorAll<HTMLElement>('[data-mid]').forEach(el=>{ const r=el.getBoundingClientRect(); if(r.bottom>bounds.top+4 && r.top<bounds.bottom-4) id=Math.max(id,Number(el.dataset.mid)); });
  if(!id || id<=(acknowledged.get(c.key)||0)) return;
  acknowledged.set(c.key,id);
  O.api('/api/messages/read',{...c.to,id}).then(()=>O.onRead(c.key)).catch(()=>{if(acknowledged.get(c.key)===id) acknowledged.delete(c.key);});
}
const queueRead=()=>{clearTimeout(readTimer);readTimer=window.setTimeout(markVisible,250);};
export function observeMessages() {
  observer?.disconnect();
  const box=document.getElementById('msgs'); if(!box) return;
  observer=new IntersectionObserver(queueRead,{root:box,threshold:[0,.5,1]});
  box.querySelectorAll('[data-mid]').forEach(el=>observer!.observe(el));
  queueRead(); drawReceipts();
}
window.addEventListener('focus',queueRead);
document.addEventListener('visibilitychange',queueRead);
function chooseReply(m:Message) {
  const c=O.conv(); if(!c) return;
  replies.set(c.key,m);drawReply();document.querySelector<HTMLTextAreaElement>('#send textarea')?.focus();
}
function menu(m:Message,x:number,y:number) {
  document.querySelector('.message-menu')?.remove();
  const el=document.createElement('div');el.className='t-menu message-menu';el.setAttribute('role','menu');
  const selected=window.getSelection()?.toString() || '';
  el.innerHTML=`<button data-m="reply" role="menuitem">↩ Ответить</button><button data-m="copy" role="menuitem">Копировать ${selected?'выделенное':'текст'}</button><button data-m="select" role="menuitem">Выделить сообщение</button>${m.sender===O.me()?`<button data-act="delmsg" data-id="${m.id}" class="danger" role="menuitem">Удалить у всех</button>`:''}`;
  document.body.append(el);el.style.left=Math.max(8,Math.min(x,innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(y,innerHeight-el.offsetHeight-8))+'px';
  el.onclick=async e=>{
    const b=(e.target as HTMLElement).closest<HTMLElement>('button');if(!b) return;
    if(b.dataset.act) document.querySelector<HTMLElement>(`[data-mid="${m.id}"] [data-act="delmsg"]`)?.click();
    if(b.dataset.m==='reply') chooseReply(m);
    if(b.dataset.m==='copy') {try {await navigator.clipboard.writeText(selected||m.text||m.file?.name||'');}catch{O.toast('Не удалось скопировать текст');}}
    if(b.dataset.m==='select') {const row=document.querySelector(`[data-mid="${m.id}"]`);if(row){const range=document.createRange();range.selectNodeContents(row);const sel=getSelection();sel?.removeAllRanges();sel?.addRange(range);}}
    el.remove();
  };
  const close=(e:Event)=>{if(!el.contains(e.target as Node)){el.remove();document.removeEventListener('pointerdown',close);}};
  setTimeout(()=>document.addEventListener('pointerdown',close),0);
  el.addEventListener('keydown',e=>{if(e.key==='Escape') el.remove();});
  el.querySelector('button')?.focus();
}
export function bindMessageTools(box:HTMLElement) {
  box.onclick=e=>{
    const el=e.target as HTMLElement, row=el.closest<HTMLElement>('[data-mid]');
    const quote=el.closest<HTMLElement>('[data-reply-target]');
    if(quote){const original=box.querySelector<HTMLElement>(`[data-mid="${quote.dataset.replyTarget}"]`);if(original){original.scrollIntoView({block:'center',behavior:'smooth'});original.animate([{background:'var(--accent)'},{background:'transparent'}],1000);}else O.toast('Сообщение выше в истории или уже удалено');return;}
    const action=el.closest<HTMLElement>('[data-msg-action]');
    if(!row || !action) return;
    const m=O.messages().find(m=>m.id===Number(row.dataset.mid));if(!m) return;
    if(action.dataset.msgAction==='reply') chooseReply(m);else {const r=action.getBoundingClientRect();menu(m,r.left,r.bottom);}
  };
  box.oncontextmenu=e=>{const row=(e.target as HTMLElement).closest<HTMLElement>('[data-mid]');const m=row && O.messages().find(m=>m.id===Number(row.dataset.mid));if(m&&!m.kind){e.preventDefault();menu(m,e.clientX,e.clientY);}};
  box.addEventListener('mouseup',e=>{if(e.button!==0 || (e.target as HTMLElement).closest('button,a,input,video,audio'))return;const selection=getSelection();if(!selection || selection.isCollapsed || !selection.toString().trim())return;const node=selection.anchorNode,element=node instanceof Element?node:node?.parentElement;const row=element?.closest<HTMLElement>('[data-mid]');const m=row&&O.messages().find(m=>m.id===Number(row.dataset.mid));if(m&&!m.kind)menu(m,e.clientX,e.clientY+8);});
  let hold=0;
  box.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;const row=(e.target as HTMLElement).closest<HTMLElement>('[data-mid]');const m=row&&O.messages().find(m=>m.id===Number(row.dataset.mid));if(m&&!m.kind)hold=window.setTimeout(()=>menu(m,e.clientX,e.clientY),550);});
  for(const type of ['pointerup','pointercancel','pointermove'])box.addEventListener(type,()=>clearTimeout(hold));
}
export function bindComposerTools(c:Conv) {
  recordCancel?.(); drawReply();
  document.getElementById('voice-btn')!.onclick=()=>startRecording(c);
  document.getElementById('sticker-btn')!.onclick=()=>openStickers(c);
}
async function startRecording(c:Conv) {
  if(recordCancel) return;
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return O.toast('Запись голоса недоступна. Откройте Startrack по HTTPS в современном браузере.');
  const status=document.getElementById('voice-status')!; status.hidden=false; status.textContent='Подключаю микрофон…';
  let stream:MediaStream|null=null, rec:MediaRecorder|null=null, timer=0, limit=0, url='', cancelled=false;
  const cleanup=()=>{cancelled=true;clearInterval(timer);clearTimeout(limit);if(rec?.state==='recording')rec.stop();stream?.getTracks().forEach(t=>t.stop());if(url)URL.revokeObjectURL(url);status.hidden=true;status.replaceChildren();recordCancel=null;};
  recordCancel=cleanup;
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    if(cancelled){stream.getTracks().forEach(t=>t.stop());return;}
    const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
    rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
    const chunks:Blob[]=[];let seconds=0;const started=performance.now();
    rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    rec.onerror=()=>{cleanup();O.toast('Не удалось записать голосовое сообщение');};
    rec.onstop=()=>{
      clearInterval(timer);clearTimeout(limit);stream?.getTracks().forEach(t=>t.stop());if(cancelled)return;
      const blob=new Blob(chunks,{type:rec!.mimeType}); if(!blob.size){cleanup();return O.toast('Запись пустая');}
      url=URL.createObjectURL(blob);
      status.innerHTML=`<audio controls src="${url}"></audio><button type="button" class="btn sm" data-v="send">Отправить</button><button type="button" class="ibtn" data-v="cancel" aria-label="Удалить запись">${O.icon('trash',18)}</button>`;
      const duration=Math.min(300,(performance.now()-started)/1000);
      status.querySelector('[data-v="send"]')!.addEventListener('click',()=>{const reply=replyId(c.key), ext=blob.type.includes('ogg')?'ogg':blob.type.includes('mp4')?'m4a':'webm';O.upload(c,new File([blob],`Голосовое ${new Date().toISOString().replace(/[:.]/g,'-')}.${ext}`,{type:blob.type}),{media:'voice',reply,duration});clearReply(c.key);cleanup();});
      status.querySelector('[data-v="cancel"]')!.addEventListener('click',cleanup);
    };
    status.innerHTML=`<span class="recording-dot"></span><b>0:00</b><span>Запись голосового</span><button type="button" class="btn sm" data-v="stop">Готово</button><button type="button" class="ibtn" data-v="cancel" aria-label="Отменить запись">${O.icon('close',18)}</button>`;
    status.querySelector('[data-v="stop"]')!.addEventListener('click',()=>rec?.state==='recording'&&rec.stop());
    status.querySelector('[data-v="cancel"]')!.addEventListener('click',cleanup);
    rec.start(500);timer=window.setInterval(()=>{seconds++;const b=status.querySelector('b');if(b)b.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;},1000);
    limit=window.setTimeout(()=>rec?.state==='recording'&&rec.stop(),300000);
  }catch(err){cleanup();O.toast((err as Error).name==='NotAllowedError'?'Разрешите доступ к микрофону для записи голосового':'Микрофон недоступен: '+(err as Error).message);}
}
type Sticker={id:string;name:string};
async function stickerFile(file:File):Promise<Blob> {
  if(file.type==='image/gif')return file;
  const bitmap=await createImageBitmap(file);
  const canvas=document.createElement('canvas');
  const k=Math.min(1,512/bitmap.width,512/bitmap.height),w=bitmap.width*k,h=bitmap.height*k;
  canvas.width=Math.max(1,Math.round(w));canvas.height=Math.max(1,Math.round(h));
  canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Не удалось создать стикер')),'image/webp',.9));
}
async function openStickers(c:Conv) {
  picker?.remove();const el=document.createElement('div');picker=el;el.className='sticker-overlay';
  el.innerHTML=`<section class="sticker-picker" role="dialog" aria-modal="true" aria-label="Мои стикеры"><header><b>Мои стикеры</b><button class="ibtn" data-s="close" aria-label="Закрыть">${O.icon('close',20)}</button></header><p>Создайте стикер из картинки. PNG и WebP сохраняют прозрачность, GIF — анимацию.</p><button class="btn" data-s="new">+ Создать стикер</button><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><div class="sticker-grid">Загрузка…</div><div class="sticker-error" role="status"></div></section>`;
  document.body.append(el);const close=()=>{el.remove();if(picker===el)picker=null;};
  el.onclick=e=>{if(e.target===el)close();};el.querySelector('[data-s="close"]')!.addEventListener('click',close);
  el.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
  const grid=el.querySelector('.sticker-grid')!,error=el.querySelector('.sticker-error')!;
  const draw=(list:Sticker[])=>{grid.innerHTML=list.length?list.map(s=>`<div><button class="sticker-send" data-id="${s.id}" title="Отправить: ${O.esc(s.name)}"><img src="${O.esc(O.server()+'/api/stickers/'+s.id+'?token='+encodeURIComponent(O.token()))}" alt="${O.esc(s.name)}"></button><button class="sticker-delete" data-del="${s.id}" aria-label="Удалить стикер">×</button></div>`).join(''):'<p>Здесь будут ваши стикеры</p>';};
  const file=el.querySelector<HTMLInputElement>('input')!;
  el.querySelector('[data-s="new"]')!.addEventListener('click',()=>file.click());
  file.onchange=async()=>{
    if(!file.files?.[0])return;error.textContent='Создаю стикер…';
    try{const src=file.files[0];if(src.size>25*1024*1024)throw new Error('Картинка больше 25 МБ');const blob=await stickerFile(src);const r=await fetch(O.server()+'/api/stickers/upload?name='+encodeURIComponent(src.name),{method:'POST',headers:{Authorization:'Bearer '+O.token(),'Content-Type':blob.type},body:blob});const body=await r.json();if(!r.ok)throw new Error(body.error);draw(body);error.textContent='';}catch(err){error.textContent=(err as Error).message;}file.value='';
  };
  grid.addEventListener('click',async e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b)return;b.disabled=true;try{if(b.dataset.del)draw(await O.api('/api/stickers/delete',{id:b.dataset.del}));else {await O.api('/api/stickers/send',{...c.to,id:b.dataset.id,reply:replyId(c.key)});clearReply(c.key);close();}}catch(err){error.textContent=(err as Error).message;b.disabled=false;}});
  try{draw(await O.api('/api/stickers'));}catch(err){error.textContent=(err as Error).message;}
  el.querySelector<HTMLButtonElement>('[data-s="new"]')!.focus();
}
