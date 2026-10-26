// Звуки интерфейса в духе Discord: синтезируем на лету через Web Audio, файлов не нужно.
// Мягкий «колокольчик»: основной тон + быстро затухающие обертоны.

type Note = { f: number; t: number; d: number; v?: number; to?: number };
export type Sfx = 'message' | 'connect' | 'disconnect' | 'join' | 'leave' | 'mute' | 'unmute'
  | 'deafen' | 'undeafen' | 'streamStart' | 'streamEnd' | 'calling' | 'ring';

const N = { A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.51 };

const SOUNDS: Record<Sfx, Note[]> = {
  message: [{ f: N.B5, t: 0, d: 0.16, v: 0.5, to: N.B5 * 1.02 }, { f: N.E6, t: 0.07, d: 0.4, v: 0.42 }],
  // сам вошёл / вышел — три ноты, кто-то другой — две
  connect: [{ f: N.C5, t: 0, d: 0.3 }, { f: N.E5, t: 0.09, d: 0.3 }, { f: N.G5, t: 0.18, d: 0.5 }],
  disconnect: [{ f: N.G5, t: 0, d: 0.3 }, { f: N.E5, t: 0.09, d: 0.3 }, { f: N.C5, t: 0.18, d: 0.5 }],
  join: [{ f: N.G5, t: 0, d: 0.25, v: 0.45 }, { f: N.C6, t: 0.1, d: 0.45, v: 0.45 }],
  leave: [{ f: N.C6, t: 0, d: 0.25, v: 0.45 }, { f: N.G5, t: 0.1, d: 0.45, v: 0.45 }],
  mute: [{ f: N.E5, t: 0, d: 0.12, v: 0.45 }, { f: N.A4, t: 0.07, d: 0.2, v: 0.45 }],
  unmute: [{ f: N.A4, t: 0, d: 0.12, v: 0.45 }, { f: N.E5, t: 0.07, d: 0.2, v: 0.45 }],
  deafen: [{ f: N.G5, t: 0, d: 0.12, v: 0.4 }, { f: N.D5, t: 0.07, d: 0.12, v: 0.4 }, { f: N.G5 / 2, t: 0.14, d: 0.25, v: 0.45 }],
  undeafen: [{ f: N.G5 / 2, t: 0, d: 0.12, v: 0.4 }, { f: N.D5, t: 0.07, d: 0.12, v: 0.4 }, { f: N.G5, t: 0.14, d: 0.25, v: 0.45 }],
  streamStart: [{ f: 420, t: 0, d: 0.22, v: 0.3, to: 840 }, { f: N.A5, t: 0.16, d: 0.2, v: 0.4 }, { f: N.E6, t: 0.24, d: 0.45, v: 0.35 }],
  streamEnd: [{ f: N.E6, t: 0, d: 0.15, v: 0.35 }, { f: N.A5, t: 0.08, d: 0.2, v: 0.4 }, { f: 840, t: 0.16, d: 0.3, v: 0.3, to: 420 }],
  // гудки: исходящий вызов и входящий звонок (если нет своей мелодии)
  calling: [{ f: N.D5, t: 0, d: 0.7, v: 0.35 }, { f: N.A5, t: 0.22, d: 0.9, v: 0.3 }],
  ring: [{ f: N.E5, t: 0, d: 0.3 }, { f: N.A5, t: 0.12, d: 0.3 }, { f: N.E5, t: 0.24, d: 0.3 }, { f: N.A5, t: 0.36, d: 0.3 }, { f: N.C6, t: 0.48, d: 0.8 }],
};
const LOOP_MS: Partial<Record<Sfx, number>> = { calling: 2600, ring: 2000 };

// Группы для настроек: какой переключатель отвечает за какие звуки
export const SFX_GROUPS = {
  message: { title: 'Новое сообщение', hint: 'Сообщение от друга или в группе', sounds: ['message'] },
  call: { title: 'Вход и выход из звонка', hint: 'Вы или собеседник подключились или отключились', sounds: ['connect', 'disconnect', 'join', 'leave'] },
  mute: { title: 'Микрофон', hint: 'Выключение и включение микрофона', sounds: ['mute', 'unmute'] },
  deafen: { title: 'Звук', hint: 'Отключение и включение звука', sounds: ['deafen', 'undeafen'] },
  stream: { title: 'Демонстрация экрана', hint: 'Начало и конец демонстрации', sounds: ['streamStart', 'streamEnd'] },
  calling: { title: 'Исходящий вызов', hint: 'Гудки, пока друг не ответил', sounds: ['calling'] },
} as const satisfies Record<string, { title: string; hint: string; sounds: Sfx[] }>;
export type SfxGroup = keyof typeof SFX_GROUPS;

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
const off = new Set((get('sfxOff') || '').split(',').filter(Boolean));
export let sfxVol = Number(get('sfxVol') ?? 0.6);
let sinkId = '';

export const sfxOn = (g: SfxGroup) => !off.has(g);
export function setSfxOn(g: SfxGroup, on: boolean) {
  if (on) off.delete(g); else off.add(g);
  set('sfxOff', [...off].join(','));
}
export function setSfxVol(v: number) {
  sfxVol = v;
  set('sfxVol', String(v));
}
const groupOf = (s: Sfx) => (Object.keys(SFX_GROUPS) as SfxGroup[]).find((g) => (SFX_GROUPS[g].sounds as readonly Sfx[]).includes(s));

let ctx: AudioContext | null = null;
export function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (sinkId !== ((ctx as any).sinkId || '')) (ctx as any).setSinkId?.(sinkId).catch(() => {});
  return ctx;
}
// Динамики из настроек голоса ('' — устройство по умолчанию)
export function setSfxOutput(id: string) {
  sinkId = id === 'default' ? '' : id;
  if (ctx) audio();
}

// Проигрывает звук; возвращает узел, через который его можно оборвать
function render(notes: Note[], vol: number) {
  const c = audio();
  const out = c.createGain();
  out.gain.value = vol;
  out.connect(c.destination);
  const t0 = c.currentTime + 0.01;
  let end = 0;
  for (const n of notes) {
    const v = (n.v ?? 0.5) * 0.35;
    // обертоны: 1× — основа, 2× и 3× дают «стеклянный» призвук и гаснут быстрее
    for (const [mul, k, dk] of [[1, 1, 1], [2, 0.22, 0.5], [3, 0.06, 0.3]]) {
      const o = c.createOscillator(), g = c.createGain();
      const t = t0 + n.t, d = n.d * dk;
      o.type = 'sine';
      o.frequency.setValueAtTime(n.f * mul, t);
      if (n.to) o.frequency.exponentialRampToValueAtTime(n.to * mul, t + n.d * 0.8);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v * k, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + d + 0.05);
      end = Math.max(end, n.t + d);
    }
  }
  setTimeout(() => out.disconnect(), (end + 0.2) * 1000);
  return out;
}

export function sfx(s: Sfx, force = false) {
  const g = groupOf(s);
  if (!force && g && !sfxOn(g)) return;
  if (sfxVol <= 0) return;
  try { render(SOUNDS[s], sfxVol); } catch {}
}

// Повторяющиеся гудки (исходящий вызов, входящий звонок); on=false — остановить
const loops = new Map<Sfx, { timer: number; out: GainNode | null }>();
export function sfxLoop(s: Sfx, on: boolean) {
  const cur = loops.get(s);
  if (!on) {
    if (!cur) return;
    clearInterval(cur.timer);
    cur.out?.gain.setTargetAtTime(0, ctx!.currentTime, 0.03);
    loops.delete(s);
    return;
  }
  if (cur) return;
  const g = groupOf(s);
  if (g && !sfxOn(g)) return;
  const tick = () => { try { l.out = render(SOUNDS[s], Math.max(sfxVol, 0.15)); } catch {} };
  const l = { timer: window.setInterval(tick, LOOP_MS[s] ?? 2000), out: null as GainNode | null };
  loops.set(s, l);
  tick();
}
