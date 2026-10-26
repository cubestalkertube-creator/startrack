// Звуковая панель, как в Discord. Нажатый звук каждый участник звонка проигрывает у себя
// (команда приходит через LiveKit): встроенные звуки синтезируем, свои — файлы с сервера.
// Так у каждого своя громкость панели и свои динамики, а голосу звук не мешает.
import { audio } from './sounds';

// id: b:<имя> — встроенный, f:<номер> — загруженный (file — имя файла на сервере, uid — чей)
export type SbSound = { id: string; name: string; emoji: string; vol: number; file?: string; uid?: number };

export const BUILTIN: SbSound[] = [
  { id: 'b:airhorn', name: 'Гудок', emoji: '📢', vol: 0.8 },
  { id: 'b:sad', name: 'Грустный тромбон', emoji: '🎺', vol: 1 },
  { id: 'b:badum', name: 'Ба-дум-тсс', emoji: '🥁', vol: 1 },
  { id: 'b:cricket', name: 'Сверчки', emoji: '🦗', vol: 1 },
  { id: 'b:clap', name: 'Аплодисменты', emoji: '👏', vol: 1 },
  { id: 'b:quack', name: 'Кря', emoji: '🦆', vol: 1 },
  { id: 'b:tada', name: 'Тадам', emoji: '🎉', vol: 0.9 },
];

export const SB_MAX_SEC = 5.2; // длиннее звук обрезаем, как в Discord

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
export let sbVol = Number(get('sbVol') ?? 0.8);
export function setSbVol(v: number) {
  sbVol = v;
  set('sbVol', String(v));
}

// ---------- синтез встроенных звуков ----------
let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext) {
  if (noiseBuf?.sampleRate === c.sampleRate) return noiseBuf;
  noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
// огибающая громкости: быстрая атака, держим, затухание
function env(g: GainNode, t: number, d: number, v: number, a = 0.01, r = 0.08) {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v, t + a);
  g.gain.setValueAtTime(v, t + Math.max(a, d - r));
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
}
type Tone = { type?: OscillatorType; f: number; to?: number; t: number; d: number; v: number; a?: number; r?: number; filter?: AudioNode };
function tone(c: AudioContext, out: AudioNode, n: Tone) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = n.type ?? 'sawtooth';
  o.frequency.setValueAtTime(n.f, n.t);
  if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, n.t + n.d);
  env(g, n.t, n.d, n.v, n.a, n.r);
  o.connect(g).connect(n.filter ?? out);
  o.start(n.t);
  o.stop(n.t + n.d + 0.05);
  return o;
}
// шум через фильтр: тарелки, хлопки, малый барабан
function hiss(c: AudioContext, out: AudioNode, t: number, d: number, v: number, type: BiquadFilterType, f: number, q = 1) {
  const src = c.createBufferSource(), flt = c.createBiquadFilter(), g = c.createGain();
  src.buffer = noise(c);
  flt.type = type;
  flt.frequency.value = f;
  flt.Q.value = q;
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(flt).connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + d + 0.05);
}
function lowpass(c: AudioContext, out: AudioNode, f: number, q = 0.7) {
  const flt = c.createBiquadFilter();
  flt.type = 'lowpass';
  flt.frequency.value = f;
  flt.Q.value = q;
  flt.connect(out);
  return flt;
}

// каждый возвращает длительность в секундах
const SYNTH: Record<string, (c: AudioContext, out: AudioNode, t: number) => number> = {
  airhorn(c, out, t) {
    const flt = lowpass(c, out, 2800, 1.5);
    for (const [s, d] of [[0, 0.2], [0.27, 0.2], [0.54, 1.1]])
      for (const f of [415, 421, 526, 532]) tone(c, out, { f: f * 0.93, to: f, t: t + s, d, v: 0.09, a: 0.015, r: 0.06, filter: flt });
    return 1.7;
  },
  sad(c, out, t) {
    const notes = [[392, 0, 0.38], [370, 0.42, 0.38], [349, 0.84, 0.38], [330, 1.26, 1.5]];
    for (const [f, s, d] of notes) {
      const flt = c.createBiquadFilter();
      flt.type = 'lowpass';
      flt.Q.value = 6;
      // «вау» — фильтр открывается и закрывается на каждой ноте
      flt.frequency.setValueAtTime(300, t + s);
      flt.frequency.linearRampToValueAtTime(1700, t + s + 0.12);
      flt.frequency.linearRampToValueAtTime(700, t + s + d);
      flt.connect(out);
      const o = tone(c, out, { f, to: d > 1 ? f * 0.96 : undefined, t: t + s, d, v: 0.25, a: 0.03, r: 0.12, filter: flt });
      if (d > 1) { // дрожание в конце
        const lfo = c.createOscillator(), depth = c.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.value = 9;
        lfo.connect(depth).connect(o.frequency);
        lfo.start(t + s + 0.3);
        lfo.stop(t + s + d);
      }
    }
    return 2.8;
  },
  badum(c, out, t) {
    hiss(c, out, t, 0.14, 0.5, 'bandpass', 1800, 0.8); // ба — малый
    tone(c, out, { type: 'triangle', f: 200, to: 150, t, d: 0.1, v: 0.5 });
    tone(c, out, { type: 'sine', f: 150, to: 85, t: t + 0.2, d: 0.3, v: 0.9, r: 0.25 }); // дум — том
    hiss(c, out, t + 0.45, 1.3, 0.35, 'highpass', 6500); // тсс — тарелка
    hiss(c, out, t + 0.45, 0.5, 0.2, 'bandpass', 9000, 2);
    return 1.9;
  },
  cricket(c, out, t) {
    for (const [f, off] of [[4600, 0], [4250, 0.23]])
      for (let g = 0; g < 4; g++)
        for (let p = 0; p < 3; p++) tone(c, out, { type: 'sine', f, t: t + off + g * 0.5 + p * 0.042, d: 0.026, v: 0.12, a: 0.004, r: 0.015 });
    return 2.3;
  },
  clap(c, out, t) {
    for (const s of [0, 0.48, 1.02, 1.47, 1.98, 2.45]) {
      const w = t + s + Math.random() * 0.04;
      // хлопок — несколько коротких всплесков шума подряд
      for (const k of [0, 0.009, 0.018]) hiss(c, out, w + k, k ? 0.02 : 0.12, 0.7, 'bandpass', 1150, 1.1);
    }
    return 2.7;
  },
  quack(c, out, t) {
    for (const s of [0, 0.3]) {
      const form = c.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1150;
      form.Q.value = 3;
      form.connect(out);
      tone(c, out, { f: 420, to: 310, t: t + s, d: 0.19, v: 0.9, a: 0.006, r: 0.1, filter: form });
      tone(c, out, { type: 'square', f: 840, to: 620, t: t + s, d: 0.15, v: 0.06, a: 0.006 });
    }
    return 0.6;
  },
  tada(c, out, t) {
    const flt = lowpass(c, out, 2600);
    for (const f of [523.25, 659.25, 783.99]) tone(c, out, { f, t, d: 0.13, v: 0.09, filter: flt });
    for (const f of [523.25, 659.25, 783.99, 1046.5]) tone(c, out, { f, t: t + 0.17, d: 1.1, v: 0.09, a: 0.02, r: 0.5, filter: flt });
    return 1.4;
  },
};

// ---------- свои звуки ----------
const cache = new Map<string, Promise<AudioBuffer>>();
function load(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, { signal: AbortSignal.timeout(20000) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((b) => audio().decodeAudioData(b));
    p.catch(() => cache.delete(url)); // в другой раз попробуем снова
    cache.set(url, p);
  }
  return p;
}
export const preload = (server: string, s: SbSound) => { if (s.file) load(`${server}/api/sounds/${s.file}`).catch(() => {}); };

const playing = new Set<GainNode>();
// Проигрывает звук панели у себя; server — адрес сервера (для своих звуков)
export async function playSound(server: string, s: Pick<SbSound, 'id' | 'vol' | 'file'>) {
  const c = audio();
  const out = c.createGain();
  out.gain.value = Math.max(0, Math.min(1, s.vol)) * sbVol;
  let dur: number;
  if (s.id.startsWith('b:')) {
    const fn = SYNTH[s.id.slice(2)];
    if (!fn) return;
    out.connect(c.destination);
    dur = fn(c, out, c.currentTime + 0.02);
  } else {
    if (!s.file || !/^[0-9a-f]{32}\.(wav|mp3|ogg)$/.test(s.file)) return;
    const buf = await load(`${server}/api/sounds/${s.file}`);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(out).connect(c.destination);
    src.start();
    dur = buf.duration;
  }
  playing.add(out);
  setTimeout(() => { out.disconnect(); playing.delete(out); }, (dur + 0.3) * 1000);
}
// Отключили звук — обрываем всё, что играет
export function stopSounds() {
  for (const g of playing) g.disconnect();
  playing.clear();
}

// ---------- загрузка своего звука ----------
export const decodeFile = async (file: Blob) => audio().decodeAudioData(await file.arrayBuffer());

// Кусок звука [start, start+dur) в моно 44.1 кГц WAV (16 бит) — меньше 0.5 МБ при 5 секундах
export async function cutWav(buf: AudioBuffer, start: number, dur: number): Promise<Blob> {
  const sr = 44100;
  const n = Math.max(1, Math.round(dur * sr));
  const off = new OfflineAudioContext(1, n, sr);
  const src = off.createBufferSource();
  const g = off.createGain();
  src.buffer = buf;
  // короткие нарастание и затухание по краям — без щелчков
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.005);
  g.gain.setValueAtTime(1, Math.max(0.005, dur - 0.03));
  g.gain.linearRampToValueAtTime(0, dur);
  src.connect(g).connect(off.destination);
  src.start(0, start, dur);
  const pcm = (await off.startRendering()).getChannelData(0);
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([data], { type: 'audio/wav' });
}

// Прослушать кусок до загрузки (только у себя)
let previewSrc: AudioBufferSourceNode | null = null;
export function preview(buf: AudioBuffer | null, start = 0, dur = SB_MAX_SEC, vol = 1) {
  previewSrc?.stop();
  previewSrc = null;
  if (!buf) return;
  const c = audio();
  const src = c.createBufferSource(), g = c.createGain();
  src.buffer = buf;
  g.gain.value = vol * sbVol;
  src.connect(g).connect(c.destination);
  src.start(0, start, dur);
  src.onended = () => { if (previewSrc === src) previewSrc = null; };
  previewSrc = src;
}
