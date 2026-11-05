// HTMLMediaElement.volume stops at 1. Web Audio provides actual amplification up to 2.
let context:AudioContext|null=null;
const nodes=new Map<HTMLMediaElement,{source:MediaStreamAudioSourceNode;gain:GainNode;destination:MediaStreamAudioDestinationNode;original:MediaProvider|null}>();
export function applyAudioGain(el:HTMLAudioElement,value:number) {
  value=Math.max(0,Math.min(2,Number.isFinite(value)?value:1));
  let node=nodes.get(el);
  if(!node && value>1 && el.srcObject instanceof MediaStream) {
    try {
      context??=new AudioContext();
      const original=el.srcObject,source=context.createMediaStreamSource(original),gain=context.createGain(),destination=context.createMediaStreamDestination();
      source.connect(gain).connect(destination);
      node={source,gain,destination,original};nodes.set(el,node);el.srcObject=destination.stream;
      void el.play().catch(()=>{});
    }catch{el.volume=Math.min(1,value);return;}
  }
  if(node){el.volume=1;node.gain.gain.setValueAtTime(value,context!.currentTime);void context!.resume().catch(()=>{});}else el.volume=Math.min(1,value);
}
export function disconnectAudioGain(el:HTMLMediaElement){const n=nodes.get(el);if(n){n.source.disconnect();n.gain.disconnect();n.destination.stream.getTracks().forEach(t=>t.stop());nodes.delete(el);}}
window.addEventListener('pointerdown',()=>{if(context?.state==='suspended')void context.resume();},{passive:true});
