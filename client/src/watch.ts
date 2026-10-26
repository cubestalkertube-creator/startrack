// Совместный просмотр YouTube в звонке, как активность в Discord. У каждого свой плеер, а что играет,
// с какой секунды и на паузе ли — согласуем сообщениями через LiveKit. Включить, поставить на паузу,
// перемотать или добавить видео в очередь может любой участник, остальные следуют за ним.
export type Vid = { id: string; title: string; by: string }; // by — кто добавил (имя)
// v — номер версии: из двух состояний верное то, у которого v больше (при равных — больший by)
export type WState = { v: number; by: string; on: boolean; vid: Vid | null; playing: boolean; pos: number; queue: Vid[] };
export type WMsg = { t: 'state'; s: WState } | { t: 'sync'; v: number; by: string; pos: number };

type Opts = {
  me(): string; // свой identity в комнате
  // я главный: у меня самый маленький identity (не считая except) — отвечаю новичкам, сверяю время, листаю очередь
  leader(except?: string): boolean;
  send(m: WMsg, to?: string[]): void;
  myName(): string;
  info(id: string): Promise<string>; // название видео
  toast(text: string): void;
  ic(name: string, size?: number): string;
  esc(s: string): string;
  changed(): void; // активность включили или выключили — перерисовать звонок
};

const MAX_QUEUE = 50;
let O: Opts;
let st: WState | null = null;
let recvAt = 0; // когда стало известно st.pos
let player: any = null;
let ready = false;
let loadedId = '';
let quiet = 0; // до этого момента изменения в плеере — наши собственные, а не действия пользователя
let deaf = false;
let tile: HTMLElement | null = null;
let timers: number[] = [];
let last = { t: 0, pos: 0, ps: -1 };

export const initWatch = (o: Opts) => { O = o; };
export const watchOn = () => !!st?.on;

const now = () => performance.now();
const quietFor = (ms = 1500) => { quiet = Math.max(quiet, now() + ms); };
const expected = () => !st ? 0 : st.playing ? st.pos + (now() - recvAt) / 1000 : st.pos;
const newer = (a: WState, b: WState | null) => !b || a.v > b.v || (a.v === b.v && a.by > b.by);
const curTime = () => { try { return player && ready && loadedId ? Number(player.getCurrentTime()) || 0 : expected(); } catch { return expected(); } };
const pstate = () => { try { return player && ready ? player.getPlayerState() as number : -1; } catch { return -1; } };

// Ссылка (или id) на видео YouTube -> id и время начала из ?t=
export function parseYt(text: string): { id: string; t: number } | null {
  const s = text.trim();
  if (/^[\w-]{11}$/.test(s)) return { id: s, t: 0 };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com')
    id = u.searchParams.get('v') || /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] || '';
  if (!/^[\w-]{11}$/.test(id)) return null;
  const tm = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(u.searchParams.get('t') || u.searchParams.get('start') || '');
  const t = tm ? (Number(tm[1] || 0) * 3600 + Number(tm[2] || 0) * 60 + Number(tm[3] || 0)) : 0;
  return { id, t };
}

function accept(s: WState) {
  const was = !!st?.on;
  st = s;
  recvAt = now();
  if (!s.on) destroy();
  if (was !== s.on) O.changed();
  draw();
  syncPlayer();
}

// Своё действие: новая версия состояния — себе и всем
function commit(patch: Partial<WState>) {
  const base: WState = st ?? { v: 0, by: '', on: true, vid: null, playing: false, pos: 0, queue: [] };
  const s: WState = { ...base, pos: base.vid ? curTime() : 0, ...patch, v: base.v + 1, by: O.me() };
  accept(s);
  O.send({ t: 'state', s });
}

export const watchStart = () => { if (!st?.on) commit({ on: true, vid: null, queue: [], playing: false, pos: 0 }); };

export function watchOnData(m: WMsg) {
  if (m.t === 'state') { if (m.s && typeof m.s.v === 'number' && newer(m.s, st)) accept(m.s); return; }
  // главный сообщает, где сейчас видео, — подстраиваемся
  if (m.t === 'sync' && st && m.v === st.v && m.by === st.by && Number.isFinite(m.pos)) {
    st.pos = m.pos;
    recvAt = now();
  }
}

// Новый участник: главный рассказывает ему, что смотрим и где сейчас
export function watchJoined(identity: string) {
  if (!st || !O.leader(identity)) return;
  O.send({ t: 'state', s: { ...st, pos: st.vid && st.playing ? curTime() : st.pos } }, [identity]);
}

export function watchReset() {
  st = null;
  destroy();
}

export function watchDeaf(on: boolean) {
  deaf = on;
  try { if (player && ready) on ? player.mute() : player.unMute(); } catch {}
}

// ---------- плеер ----------
let apiLoad: Promise<any> | null = null;
function loadApi(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  apiLoad ??= new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { prev?.(); resolve(w.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiLoad = null; s.remove(); reject(new Error('нет связи с YouTube')); };
    document.head.append(s);
  });
  return apiLoad;
}

function syncPlayer() {
  if (!player || !ready || !st) return;
  const v = st.vid;
  if (!v) {
    if (loadedId) { quietFor(); player.stopVideo(); loadedId = ''; }
    return;
  }
  const at = expected();
  if (loadedId !== v.id) {
    loadedId = v.id;
    quietFor(4000);
    showError('');
    if (st.playing) player.loadVideoById({ videoId: v.id, startSeconds: at });
    else player.cueVideoById({ videoId: v.id, startSeconds: at });
    return;
  }
  const ps = pstate();
  const cur = curTime();
  if (st.playing) {
    if (ps !== 3 && Math.abs(cur - at) > 1) { quietFor(); player.seekTo(at, true); }
    if (ps !== 1 && ps !== 3) { quietFor(); player.playVideo(); }
  } else {
    if (ps === 1 || ps === 3) { quietFor(); player.pauseVideo(); }
    // загруженное, но не начатое видео (5) от перемотки само заиграло бы
    if (ps === 2 && Math.abs(cur - at) > 0.25) { quietFor(); player.seekTo(at, true); }
  }
}

function onState(e: { data: number }) {
  if (!st?.vid) return;
  const ps = e.data;
  if (ps === 0) { // видео кончилось — главный включает следующее
    if (O.leader()) st.queue.length ? next() : commit({ playing: false });
    return;
  }
  if (now() < quiet) return;
  if (ps === 1 && !st.playing) commit({ playing: true });
  // пауза бывает и мгновенной при перемотке ползунком — ждём, точно ли пауза
  if (ps === 2 && st.playing) setTimeout(() => { if (st?.playing && pstate() === 2 && now() >= quiet) commit({ playing: false }); }, 400);
}

const ERRORS: Record<number, string> = {
  2: 'Неверная ссылка на видео', 5: 'Плеер не может воспроизвести это видео',
  100: 'Видео удалено или скрыто', 101: 'Автор запретил смотреть это видео вне YouTube', 150: 'Автор запретил смотреть это видео вне YouTube',
};
function showError(text: string) {
  const el = tile?.querySelector<HTMLElement>('.yt-err');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// Раз в секунду: заметить перемотку в самом плеере и догнать остальных
function tick() {
  if (!st?.vid || !player || !ready || loadedId !== st.vid.id) return;
  const ps = pstate(), cur = curTime(), t = now();
  if (t >= quiet && (ps === 1 || ps === 2) && (last.ps === 1 || last.ps === 2)) {
    const exp = last.pos + (ps === 1 && last.ps === 1 ? (t - last.t) / 1000 : 0);
    // на паузе время не идёт само — любой сдвиг значит перемотку
    if (Math.abs(cur - exp) > (ps === 2 && last.ps === 2 ? 0.3 : 2)) { last = { t, pos: cur, ps }; return commit({ pos: cur, playing: ps === 1 }); }
  }
  last = { t, pos: cur, ps };
  if (t >= quiet) syncPlayer();
}
// Главный раз в 5 секунд рассылает, где видео у него, — у остальных не копится расхождение
function beat() {
  if (!st?.vid || !st.playing || !O.leader() || pstate() !== 1 || loadedId !== st.vid.id) return;
  st.pos = curTime();
  recvAt = now();
  O.send({ t: 'sync', v: st.v, by: st.by, pos: st.pos });
}

function destroy() {
  timers.forEach(clearInterval);
  timers = [];
  try { player?.destroy(); } catch {}
  player = null;
  ready = false;
  loadedId = '';
  tile = null;
}

// ---------- плитка в звонке ----------
export function watchMount(el: HTMLElement) {
  destroy();
  tile = el;
  const { ic } = O;
  el.innerHTML = `
    <div class="yt-bar">
      <span class="yt-logo">${ic('youtube', 22)}</span>
      <div class="yt-now"></div>
      <form class="yt-form"><input placeholder="Ссылка на видео YouTube" spellcheck="false">
        <button class="btn sm" data-y="play" title="Включить сейчас">Смотреть</button>
        <button type="button" class="ibtn" data-y="add" title="Добавить в очередь">${ic('plus', 20)}</button></form>
      <button class="ibtn" data-y="next" title="Следующее видео из очереди">${ic('skip', 20)}</button>
      <button class="ibtn yt-qbtn" data-y="queue" title="Очередь">${ic('queue', 20)}<i></i></button>
      <button class="ibtn" data-y="close" title="Закрыть YouTube у всех">${ic('close', 20)}</button>
    </div>
    <div class="yt-main"><div class="yt-player"><div></div></div>
      <div class="yt-empty">${ic('youtube', 56)}<b>Смотрим YouTube вместе</b><span>Вставьте ссылку на видео сверху — его увидят и услышат все в звонке. Ставить на паузу и перематывать может каждый.</span></div>
      <div class="yt-err" hidden></div></div>
    <div class="yt-q" hidden></div>`;
  const form = el.querySelector<HTMLFormElement>('.yt-form')!;
  const inp = form.querySelector('input')!;
  let busy = false;
  const add = async (now: boolean) => {
    const p = parseYt(inp.value);
    if (!p) return O.toast(inp.value.trim() ? 'Это не похоже на ссылку на YouTube' : 'Вставьте ссылку на видео');
    if (busy || !st) return;
    busy = true;
    const title = await O.info(p.id).catch(() => '');
    busy = false;
    if (!st?.on) return;
    const vid: Vid = { id: p.id, title: title || 'Видео ' + p.id, by: O.myName() };
    inp.value = '';
    if (now || !st.vid) commit({ vid, playing: true, pos: p.t });
    else if (st.queue.length >= MAX_QUEUE) O.toast(`В очереди не больше ${MAX_QUEUE} видео`);
    else { commit({ queue: [...st.queue, vid] }); O.toast(`«${vid.title}» — в очереди`); }
  };
  form.onsubmit = (e) => { e.preventDefault(); add(true); };
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-y]');
    if (!b || !st) return;
    const i = Number(b.dataset.i);
    switch (b.dataset.y) {
      case 'add': return void add(false);
      case 'next': return next();
      case 'queue': { const q = el.querySelector<HTMLElement>('.yt-q')!; q.hidden = !q.hidden; return draw(); }
      case 'close': return commit({ on: false, vid: null, queue: [], playing: false, pos: 0 });
      case 'qplay': return st.queue[i] && commit({ vid: st.queue[i], queue: st.queue.filter((_, k) => k !== i), playing: true, pos: 0 });
      case 'qdel': return commit({ queue: st.queue.filter((_, k) => k !== i) });
    }
  };
  timers.push(window.setInterval(tick, 1000), window.setInterval(beat, 5000));
  draw();
  loadApi().then((YT) => {
    if (tile !== el) return;
    player = new YT.Player(el.querySelector('.yt-player > div'), {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => { ready = true; if (deaf) player.mute(); syncPlayer(); },
        onStateChange: onState,
        onError: (e: { data: number }) => showError(ERRORS[e.data] || 'Не удалось включить видео (ошибка ' + e.data + ')'),
      },
    });
  }, (err) => { if (tile === el) showError('YouTube не загрузился: ' + err.message); });
}

function next() {
  if (!st) return;
  const [vid, ...rest] = st.queue;
  if (vid) commit({ vid, queue: rest, playing: true, pos: 0 });
  else O.toast('Очередь пуста');
}

function draw() {
  if (!tile || !st) return;
  const { esc, ic } = O;
  const v = st.vid;
  tile.querySelector('.yt-now')!.innerHTML = v
    ? `<b title="${esc(v.title)}">${esc(v.title)}</b><span>включил(а) ${esc(v.by)}</span>` : '<b>Ничего не играет</b>';
  tile.querySelector<HTMLElement>('.yt-empty')!.hidden = !!v;
  tile.querySelector<HTMLElement>('.yt-player')!.style.visibility = v ? '' : 'hidden';
  tile.querySelector<HTMLButtonElement>('[data-y="next"]')!.disabled = !st.queue.length;
  tile.querySelector('.yt-qbtn i')!.textContent = st.queue.length ? String(st.queue.length) : '';
  const q = tile.querySelector<HTMLElement>('.yt-q')!;
  if (!q.hidden) q.innerHTML = `<h5>Очередь — ${st.queue.length}</h5>` + (st.queue.map((x, i) => `
    <div class="yt-qi"><img src="https://i.ytimg.com/vi/${x.id}/mqdefault.jpg" alt="" draggable="false">
      <div><b title="${esc(x.title)}">${esc(x.title)}</b><span>добавил(а) ${esc(x.by)}</span></div>
      <button class="ibtn" data-y="qplay" data-i="${i}" title="Включить сейчас">${ic('play', 18)}</button>
      <button class="ibtn" data-y="qdel" data-i="${i}" title="Убрать из очереди">${ic('close', 18)}</button></div>`).join('')
    || '<p>Пусто. Вставьте ссылку сверху и нажмите «+», чтобы видео включилось следом.</p>');
}
