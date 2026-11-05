import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSession} from '../../client/src/watch.ts';

test('a viewer can pause and resume the shared video while the original owner coordinates state',()=>{
  globalThis.localStorage={getItem:()=>null};
  const viewers=new Set(['1','2']),out=[];
  const session=createSession({me:()=> '1',leader:()=>true,present:id=>viewers.has(id),send:m=>out.push(m),myName:()=> 'Host',nameOf:id=>id,info:async()=>'',fileUrl:id=>id,youtubeSource:async()=>({video:'',audio:null}),toast:()=>{},ic:()=>'',esc:s=>s,changed:()=>{},place:'chat'});
  session.start({src:'yt',id:'jNQXAC9IVRw',title:'Test',by:'Host'});
  assert.equal(session.state().playing,true);assert.equal(session.state().relay,false);
  session.onData({t:'control',action:'toggle',from:'2'});
  assert.equal(session.state().playing,false);assert.equal(out.at(-1).s.playing,false);assert.equal(session.state().owner,'1');
  session.onData({t:'control',action:'toggle',from:'2'});assert.equal(session.state().playing,true);
  session.onData({t:'control',action:'toggle',from:'999'});assert.equal(session.state().playing,true,'unrelated senders cannot control a session');
});
