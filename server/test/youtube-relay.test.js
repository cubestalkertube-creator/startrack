import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createYoutubeRelay} from '../src/youtube-relay.js';

test('YouTube sources are deduplicated, bounded and cannot turn the relay into a private network proxy',async()=>{
  let calls=0;
  const relay=createYoutubeRelay({verify:()=>true,extract:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {title:'public video',requested_formats:[{vcodec:'vp9',acodec:'none',url:'https://r1.googlevideo.com/video'},{vcodec:'none',acodec:'opus',url:'https://r1.googlevideo.com/audio'}]};}});
  const [a,b]=await Promise.all([relay.source('jNQXAC9IVRw'),relay.source('jNQXAC9IVRw')]);
  assert.equal(a,b);assert.equal(calls,1);assert.equal(a.audio,'https://r1.googlevideo.com/audio');
  await assert.rejects(relay.source('https://127.0.0.1/'),e=>e[0]===400);
  const bad=createYoutubeRelay({verify:()=>true,extract:async()=>({vcodec:'vp9',url:'http://127.0.0.1/private'})});
  await assert.rejects(bad.source('jNQXAC9IVRw'),e=>e[0]===503);
});

test('YouTube streams require authentication, preserve ranges and reject redirects outside media hosts',async t=>{
  let outside=false, requests=[];
  const relay=createYoutubeRelay({verify:token=>token==='authorized',extract:async()=>({title:'test',vcodec:'vp9',acodec:'opus',url:'https://r1.googlevideo.com/video'}),fetcher:async(url,options)=>{
    requests.push({url,range:options.headers.Range});
    if(outside)return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
    return new Response('abcd',{status:206,headers:{'Content-Type':'video/webm','Content-Range':'bytes 0-3/8','Content-Length':'4'}});
  }});
  const server=http.createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(!await relay.handle(req,res,new URL(req.url,'http://x'),send))send(404,{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/yt/source?v=jNQXAC9IVRw')).status,401);
  const info=await (await fetch(base+'/api/yt/source?v=jNQXAC9IVRw&token=authorized')).json();
  assert.equal(info.audio,null);assert.match(info.video,/^\/api\/yt\/stream/);
  const stream=await fetch(base+info.video+'&token=authorized',{headers:{Range:'bytes=0-3'}});
  assert.equal(stream.status,206);assert.equal(stream.headers.get('content-range'),'bytes 0-3/8');assert.equal(await stream.text(),'abcd');
  assert.equal(requests[0].range,'bytes=0-3');
  outside=true;const count=requests.length;
  assert.equal((await fetch(base+info.video+'&token=authorized')).status,502);
  assert.equal(requests.length,count+1,'must not fetch a redirect to a private address');
});
