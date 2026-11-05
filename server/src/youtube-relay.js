import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const exec=promisify(execFile);
export function createYoutubeRelay({verify, executable=process.env.YTDLP_BIN || '/opt/startrack/youtube/bin/yt-dlp', fetcher=fetch, extract}={}) {
  const cache=new Map(),pending=new Map(),failures=new Map(); let running=0;
  const allowed=value=>{try{const u=new URL(value);return u.protocol==='https:' && (u.hostname.endsWith('.googlevideo.com') || u.hostname.endsWith('.youtube.com')) && (!u.port || u.port==='443');}catch{return false;}};
  async function source(id) {
    if(!/^[\w-]{11}$/.test(id))throw [400,'Неверный адрес видео'];
    const entry=cache.get(id);if(entry && entry.until>Date.now())return entry;
    const failure=failures.get(id);if(failure && failure>Date.now())throw [503,'YouTube сейчас недоступен серверу. Попробуйте обычный плеер или повторите позже.'];
    if(pending.has(id))return pending.get(id);
    if(running>=3)throw [429,'Сервер готовит другие видео. Повторите через несколько секунд.'];
    const task=(async()=>{
      running++;
      try{
        const data=extract?await extract(id):JSON.parse((await exec(executable,[
          '--ignore-config','--no-playlist','--force-ipv4','--socket-timeout','7','--retries','0','--extractor-retries','0',
          '--js-runtimes','node:/opt/startrack/node/bin/node','--remote-components','ejs:github','--impersonate','chrome',
          '--skip-download','--dump-single-json','-f','b[vcodec^=vp9]/bv[vcodec^=vp9][height<=720]+ba[acodec^=opus]/b[ext=mp4]/bv[height<=720]+ba',
          '--','https://www.youtube.com/watch?v='+id,
        ],{timeout:35000,maxBuffer:8*1024*1024})).stdout);
        const formats=data.requested_formats || [data];
        const video=formats.find(f=>f.vcodec && f.vcodec!=='none'), audio=formats.find(f=>f.acodec && f.acodec!=='none' && f!==video);
        if(!video || !allowed(video.url) || (audio && !allowed(audio.url)))throw new Error('Unsupported media source');
        const s={video:video.url,audio:audio?.url||null,title:String(data.title||'YouTube').slice(0,300),until:Date.now()+15*60000};
        if(cache.size>=100)cache.delete(cache.keys().next().value);
        cache.set(id,s);return s;
      }catch{failures.set(id,Date.now()+20000);throw [503,'Не удалось получить видео с YouTube. Попробуйте обычный плеер или повторите позже.'];}
      finally{running--;pending.delete(id);}
    })();pending.set(id,task);return task;
  }
  async function handle(req,res,url,send) {
    if(!['/api/yt/source','/api/yt/stream'].includes(url.pathname))return false;
    if(req.method!=='GET'){send(405,{error:'Метод не поддерживается'});return true;}
    const token=(req.headers.authorization||'').replace('Bearer ','')||url.searchParams.get('token');
    if(!verify(token)){send(401,{error:'Нужно войти'});return true;}
    try{
      const id=url.searchParams.get('v')||'',s=await source(id);
      if(req.destroyed || res.destroyed)return true;
      if(url.pathname==='/api/yt/source'){send(200,{title:s.title,video:`/api/yt/stream?v=${id}&kind=video`,audio:s.audio?`/api/yt/stream?v=${id}&kind=audio`:null});return true;}
      let upstream=url.searchParams.get('kind')==='audio'?s.audio:s.video;
      if(!upstream)throw [404,'Аудиодорожка не найдена'];
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.youtube.com/'};
      if(req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range))headers.Range=req.headers.range;
      let r;
      for(let redirects=0;redirects<4;redirects++){
        if(!allowed(upstream))throw [502,'Недопустимый источник видео'];
        r=await fetcher(upstream,{headers,redirect:'manual',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
        if(![301,302,303,307,308].includes(r.status))break;
        await r.body?.cancel();upstream=new URL(r.headers.get('location')||'',upstream).href;
      }
      if(!r || ![200,206,416].includes(r.status)){cache.delete(id);await r?.body?.cancel();throw [502,'YouTube не отдал видео. Повторите подключение.'];}
      const out={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
      for(const h of ['content-type','content-length','content-range'])if(r.headers.has(h))out[h]=r.headers.get(h);
      res.writeHead(r.status,out);
      if(r.body)await pipeline(Readable.fromWeb(r.body),res);else res.end();
    }catch(e){if(!res.headersSent&&!res.destroyed)send(Array.isArray(e)?e[0]:502,{error:Array.isArray(e)?e[1]:'Видео временно недоступно'});else if(!res.destroyed)res.destroy();}
    return true;
  }
  return {handle,source};
}
