// Смотрим и слушаем вместе, как активность в Discord: видео YouTube, треки Spotify и музыка из чата.
// Сессия живёт в звонке (сообщения через LiveKit) или в беседе (через сервер). У каждого свой плеер,
// а что играет, с какой секунды и на паузе ли — согласуем сообщениями.
// Управляет тот, кто включил: пауза, перемотка, «следующее», закрыть. Остальные добавляют видео и
// песни в очередь — они включатся по порядку, когда досмотрим текущее. Если управляющий ушёл,
// управление переходит к главному из оставшихся (у кого самый маленький id).
export type Src = 'yt' | 'sp' | 'au'; // YouTube, Spotify, аудиофайл (вложение чата или прямая ссылка)
// id: YouTube — id видео; Spotify — «track/<id>» или «episode/<id>»; аудио — «f:<id вложения>» или https-ссылка
export type Item = { src: Src; id: string; title: string; by: string };
// v — номер версии: из двух состояний верное то, у которого v больше (при равных — больший by)
export type WState = { v: number; by: string; owner: string; on: boolean; vid: Item | null; playing: boolean; pos: number; queue: Item[] };
export type WMsg =
  | { t: 'state'; s: WState }
  | { t: 'sync'; v: number; by: string; pos: number }
  | { t: 'add'; item: Item; from: string }; // просьба к управляющему: добавить в очередь

export type Opts = {
  me(): string; // свой id в сессии
  // я главный: у меня самый маленький id среди участников (не считая except)
  leader(except?: string): boolean;
  present(id: string): boolean; // этот участник ещё здесь (в звонке / слушает)
  send(m: WMsg, to?: string[]): void;
  myName(): string;
  nameOf(id: string): string;
  info(it: Item): Promise<string>; // название видео или трека
  fileUrl(id: string): string; // ссылка на вложение чата (со своим токеном)
  toast(text: string): void;
  ic(name: string, size?: number): string;
  esc(s: string): string;
  changed(): void; // сессию включили или выключили — перерисовать
  leave?: () => void; // кнопка «Выйти» (беседа: перестать слушать)
  login?: (service: 'spotify' | 'youtube') => void; // окно входа в аккаунт (приложение для ПК)
  place: 'call' | 'chat';
};

const MAX_QUEUE = 100;
const SRC_NAME: Record<Src, string> = { yt: 'YouTube', sp: 'Spotify', au: 'Музыка' };

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

// open.spotify.com/(intl-ru/)track/<id> или spotify:track:<id> -> «track/<id>»
export function parseSpotify(text: string): string | null {
  const m = /^(?:spotify:(track|episode):|https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|episode)\/)([A-Za-z0-9]{22})/.exec(text.trim());
  return m ? `${m[1] || m[2]}/${m[3]}` : null;
}
export const isSpotifyList = (text: string) => /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(album|playlist|artist|show)\//.test(text.trim());

const AUDIO_URL = /^https?:\/\/[^\s<>"']+\.(mp3|ogg|oga|opus|m4a|aac|wav|flac)(\?[^\s<>"']*)?$/i;

// что вставили в поле: видео, трек или прямая ссылка на аудио
export function parseItem(text: string): { src: Src; id: string; t: number } | null {
  const yt = parseYt(text);
  if (yt) return { src: 'yt', id: yt.id, t: yt.t };
  const sp = parseSpotify(text);
  if (sp) return { src: 'sp', id: sp, t: 0 };
  if (AUDIO_URL.test(text.trim())) return { src: 'au', id: text.trim(), t: 0 };
  return null;
}

export const thumbOf = (it: Item) => it.src === 'yt' ? `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg` : '';

// ---------- плееры ----------
// Состояния как у плеера YouTube: -1 не начато, 0 кончилось, 1 играет, 2 пауза, 3 буферизация, 5 загружено
type Backend = {
  ready(): boolean;
  load(it: Item, at: number, play: boolean): void;
  play(): void;
  pause(): void;
  seek(t: number): void;
  time(): number;
  state(): number;
  volume(v: number, mute: boolean): void;
  destroy(): void;
};
type Events = { state(ps: number): void; error(text: string): void; ready(): void };

let ytLoad: Promise<any> | null = null;
function loadYt(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  ytLoad ??= new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { prev?.(); resolve(w.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytLoad = null; s.remove(); reject(new Error('нет связи с YouTube')); };
    document.head.append(s);
  });
  return ytLoad;
}

let spLoad: Promise<any> | null = null;
function loadSp(): Promise<any> {
  const w = window as any;
  if (w.__spApi) return Promise.resolve(w.__spApi);
  spLoad ??= new Promise((resolve, reject) => {
    w.onSpotifyIframeApiReady = (api: any) => { w.__spApi = api; resolve(api); };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.onerror = () => { spLoad = null; s.remove(); reject(new Error('нет связи со Spotify')); };
    document.head.append(s);
  });
  return spLoad;
}

const YT_ERRORS: Record<number, string> = {
  2: 'Неверная ссылка на видео', 5: 'Плеер не может воспроизвести это видео',
  100: 'Видео удалено или скрыто', 101: 'Автор запретил смотреть это видео вне YouTube', 150: 'Автор запретил смотреть это видео вне YouTube',
};

function ytBackend(box: HTMLElement, ev: Events): Backend {
  let player: any = null, ok = false, dead = false;
  loadYt().then((YT) => {
    if (dead) return;
    player = new YT.Player(box.firstElementChild, {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => { ok = true; ev.ready(); },
        onStateChange: (e: { data: number }) => ev.state(e.data),
        onError: (e: { data: number }) => ev.error(YT_ERRORS[e.data] || 'Не удалось включить видео (ошибка ' + e.data + ')'),
      },
    });
  }, (err) => ev.error('YouTube не загрузился: ' + err.message));
  const call = <T>(fn: () => T, d: T) => { try { return player && ok ? fn() : d; } catch { return d; } };
  return {
    ready: () => ok,
    load: (it, at, play) => call<unknown>(() => play ? player.loadVideoById({ videoId: it.id, startSeconds: at }) : player.cueVideoById({ videoId: it.id, startSeconds: at }), 0),
    play: () => call<unknown>(() => player.playVideo(), 0),
    pause: () => call<unknown>(() => player.pauseVideo(), 0),
    seek: (t) => call<unknown>(() => player.seekTo(t, true), 0),
    time: () => call(() => Number(player.getCurrentTime()) || 0, 0),
    state: () => call(() => player.getPlayerState() as number, -1),
    volume: (v, mute) => call<unknown>(() => { player.setVolume(Math.round(v * 100)); return mute ? player.mute() : player.unMute(); }, 0),
    destroy: () => { dead = true; call<unknown>(() => player.stopVideo(), 0); try { player?.destroy(); } catch {} player = null; },
  };
}

// Spotify Embed: без входа в аккаунт Spotify даёт послушать 30 секунд, со входом — трек целиком
function spBackend(box: HTMLElement, ev: Events): Backend {
  let ctl: any = null, ok = false, dead = false;
  let s = { paused: true, buf: false, pos: 0, dur: 0, at: 0, started: false };
  let want: { uri: string; at: number; play: boolean } | null = null;
  let ended = false;
  const ps = () => !s.started ? 5 : s.buf ? 3 : s.paused ? 2 : 1;
  const apply = () => {
    if (!ctl || !want) return;
    const w = want;
    want = null;
    s = { paused: true, buf: false, pos: 0, dur: 0, at: performance.now(), started: false };
    ended = false;
    ctl.loadUri(w.uri);
    // после loadUri плеер присылает ready — тогда перематываем и включаем
    const go = () => { if (w.at > 1) ctl.seek(w.at); if (w.play) ctl.play(); };
    setTimeout(go, 600);
  };
  loadSp().then((api) => {
    if (dead) return;
    api.createController(box.firstElementChild, { width: '100%', height: '100%' }, (c: any) => {
      if (dead) { try { c.destroy(); } catch {} return; }
      ctl = c;
      ok = true;
      c.addListener('playback_update', (e: any) => {
        const d = e?.data || {};
        const was = ps(), lastPos = s.pos;
        s = { paused: !!d.isPaused, buf: !!d.isBuffering, pos: Number(d.position) || 0, dur: Number(d.duration) || 0, at: performance.now(), started: s.started || !d.isPaused };
        // трек доиграл: позиция у конца, либо плеер сам встал на паузу в начале после конца
        const atEnd = s.dur > 0 && (s.pos >= s.dur - 800 || (s.paused && s.pos === 0 && lastPos > s.dur - 3000));
        if (atEnd && !ended && s.started) { ended = true; return ev.state(0); }
        if (ps() !== was) ev.state(ps());
      });
      ev.ready();
      apply();
    });
  }, (err) => ev.error('Spotify не загрузился: ' + err.message));
  return {
    ready: () => ok,
    load: (it, at, play) => { want = { uri: 'spotify:' + it.id.replace('/', ':'), at, play }; apply(); },
    play: () => { try { s.started ? ctl?.resume() : ctl?.play(); } catch {} },
    pause: () => { try { ctl?.pause(); } catch {} },
    seek: (t) => { try { ctl?.seek(t); } catch {} },
    time: () => (s.pos + (ps() === 1 ? performance.now() - s.at : 0)) / 1000,
    state: () => ended ? 0 : ps(),
    volume: () => {}, // у встроенного плеера Spotify громкости нет
    destroy: () => { dead = true; try { ctl?.destroy(); } catch {} ctl = null; },
  };
}

function auBackend(box: HTMLElement, ev: Events, url: (it: Item) => string): Backend {
  const a = box.querySelector('audio')!;
  let st = -1;
  const set = (n: number) => { if (st !== n) { st = n; ev.state(n); } };
  a.onplaying = () => set(1);
  a.onpause = () => { if (!a.ended) set(2); };
  a.onwaiting = () => set(3);
  a.onended = () => set(0);
  a.onerror = () => { if (a.getAttribute('src')) ev.error('Не удалось включить этот файл'); };
  setTimeout(() => ev.ready());
  return {
    ready: () => true,
    load: (it, at, play) => {
      st = -1;
      a.src = url(it);
      a.currentTime = at;
      if (play) a.play().catch(() => {});
      else st = 5;
    },
    play: () => { a.play().catch(() => {}); },
    pause: () => a.pause(),
    seek: (t) => { a.currentTime = t; },
    time: () => a.currentTime || 0,
    state: () => st,
    volume: (v, mute) => { a.volume = v; a.muted = mute; },
    destroy: () => { a.pause(); a.removeAttribute('src'); a.load(); },
  };
}

// ---------- сессия ----------
export type Session = ReturnType<typeof createSession>;

export function createSession(O: Opts) {
  let st: WState | null = null;
  let recvAt = 0; // когда стало известно st.pos
  const players: Partial<Record<Src, Backend>> = {};
  let cur: Src | null = null; // чей плеер сейчас показывает st.vid
  let loadedId = '';
  let quiet = 0; // до этого момента изменения в плеере — наши собственные, а не действия пользователя
  let deaf = false;
  let vol = Math.min(1, Math.max(0, Number(localStorage.getItem('wvol') ?? 0.8)));
  let tile: HTMLElement | null = null;
  let timers: number[] = [];
  let last = { t: 0, pos: 0, ps: -1 };

  const now = () => performance.now();
  const quietFor = (ms = 1500) => { quiet = Math.max(quiet, now() + ms); };
  const expected = () => !st ? 0 : st.playing ? st.pos + (now() - recvAt) / 1000 : st.pos;
  const newer = (a: WState, b: WState | null) => !b || a.v > b.v || (a.v === b.v && a.by > b.by);
  const pl = () => cur ? players[cur] : undefined;
  const curTime = () => { const p = pl(); return p?.ready() && loadedId ? p.time() : expected(); };
  const pstate = () => { const p = pl(); return p?.ready() ? p.state() : -1; };
  // кто управляет: включивший, а если его уже нет — главный из оставшихся
  const ctrlId = () => !st ? '' : O.present(st.owner) || st.owner === O.me() ? st.owner : '';
  const isCtrl = () => !!st && (st.owner === O.me() || (!O.present(st.owner) && O.leader()));

  // состояние от старых версий (без owner и src)
  function norm(s: WState): WState {
    const fix = (it: Item | null) => it && { ...it, src: it.src || 'yt' } as Item;
    return { ...s, owner: s.owner || s.by, vid: fix(s.vid), queue: (s.queue || []).map((x) => fix(x)!) };
  }

  function accept(s: WState) {
    const was = !!st?.on;
    st = norm(s);
    recvAt = now();
    if (!st.on) unload();
    if (was !== st.on) O.changed();
    draw();
    syncPlayer();
  }

  // своё действие: новая версия состояния — себе и всем
  function commit(patch: Partial<WState>) {
    const base: WState = st ?? { v: 0, by: '', owner: O.me(), on: true, vid: null, playing: false, pos: 0, queue: [] };
    const s: WState = { ...base, pos: base.vid ? curTime() : 0, ...patch, v: base.v + 1, by: O.me() };
    accept(s);
    O.send({ t: 'state', s });
  }

  function onData(m: WMsg) {
    if (m.t === 'state') { if (m.s && typeof m.s.v === 'number' && newer(m.s, st)) accept(m.s); return; }
    // управляющий сообщает, где сейчас видео, — подстраиваемся
    if (m.t === 'sync' && st && m.v === st.v && m.by === st.by && Number.isFinite(m.pos)) {
      st.pos = m.pos;
      recvAt = now();
      return;
    }
    // кто-то просит добавить в очередь — решает управляющий
    if (m.t === 'add' && st?.on && isCtrl() && m.item && (['yt', 'sp', 'au'] as Src[]).includes(m.item.src)) addItem(m.item, false, m.from);
  }

  function addItem(item: Item, playNow: boolean, from?: string) {
    if (!st?.on) return;
    if (playNow || !st.vid) return commit({ vid: item, playing: true, pos: 0 });
    if (st.queue.length >= MAX_QUEUE) return O.toast(`В очереди не больше ${MAX_QUEUE} треков и видео`);
    commit({ queue: [...st.queue, item] });
    if (from && from !== O.me()) O.toast(`${item.by} добавил(а) в очередь «${item.title}»`);
  }

  function next() {
    if (!st) return;
    const [vid, ...rest] = st.queue;
    if (vid) commit({ vid, queue: rest, playing: true, pos: 0 });
    else commit({ vid: null, playing: false, pos: 0 });
  }

  // ---------- плеер ----------
  function player(src: Src): Backend | undefined {
    if (players[src] || !tile) return players[src];
    const box = tile.querySelector<HTMLElement>(`.w-p-${src}`)!;
    const ev: Events = {
      ready: () => { applyVolume(); loadedId = ''; syncPlayer(); },
      state: (ps) => { if (cur === src) onState(ps); },
      error: (text) => { if (cur === src || !st?.vid) showError(text); },
    };
    players[src] = src === 'yt' ? ytBackend(box, ev) : src === 'sp' ? spBackend(box, ev) : auBackend(box, ev, (it) => it.id.startsWith('f:') ? O.fileUrl(it.id.slice(2)) : it.id);
    return players[src];
  }

  function syncPlayer() {
    if (!st || !tile) return;
    const v = st.vid;
    if (!v) {
      if (loadedId) { quietFor(); pl()?.pause(); loadedId = ''; }
      showPlayer(null);
      return;
    }
    if (cur && cur !== v.src) { pl()?.pause(); loadedId = ''; }
    cur = v.src;
    showPlayer(v.src);
    const p = player(v.src);
    if (!p?.ready()) return;
    const at = expected();
    if (loadedId !== v.src + v.id) {
      loadedId = v.src + v.id;
      quietFor(4000);
      showError('');
      p.load(v, at, st.playing && !(deaf && v.src === 'sp'));
      applyVolume();
      return;
    }
    const ps = p.state();
    const t = p.time();
    if (st.playing && !(deaf && v.src === 'sp')) {
      if (ps !== 3 && Math.abs(t - at) > (v.src === 'sp' ? 2.5 : 1)) { quietFor(); p.seek(at); }
      if (ps !== 1 && ps !== 3 && ps !== 0) { quietFor(); p.play(); }
    } else {
      if (ps === 1 || ps === 3) { quietFor(); p.pause(); }
      // загруженное, но не начатое видео (5) от перемотки само заиграло бы
      if (ps === 2 && Math.abs(t - at) > 0.25 && v.src !== 'sp') { quietFor(); p.seek(at); }
    }
  }

  function onState(ps: number) {
    if (!st?.vid) return;
    if (ps === 0) { // кончилось — управляющий включает следующее
      if (isCtrl()) next();
      return;
    }
    if (now() < quiet) return;
    if (!isCtrl()) { setTimeout(syncPlayer, 300); return; } // не управляющий — возвращаем как у всех
    if (ps === 1 && !st.playing) commit({ playing: true });
    // пауза бывает и мгновенной при перемотке ползунком — ждём, точно ли пауза
    if (ps === 2 && st.playing) setTimeout(() => { if (st?.playing && pstate() === 2 && now() >= quiet) commit({ playing: false }); }, 400);
  }

  // Раз в секунду: заметить перемотку в самом плеере и догнать остальных
  function tick() {
    drawProgress();
    if (!st?.vid || !pl()?.ready() || loadedId !== st.vid.src + st.vid.id) return;
    const ps = pstate(), t = curTime(), n = now();
    if (isCtrl() && n >= quiet && (ps === 1 || ps === 2) && (last.ps === 1 || last.ps === 2)) {
      const exp = last.pos + (ps === 1 && last.ps === 1 ? (n - last.t) / 1000 : 0);
      // на паузе время не идёт само — любой сдвиг значит перемотку
      if (Math.abs(t - exp) > (ps === 2 && last.ps === 2 ? 0.3 : 2.5)) { last = { t: n, pos: t, ps }; return commit({ pos: t, playing: ps === 1 }); }
    }
    last = { t: n, pos: t, ps };
    if (n >= quiet) syncPlayer();
  }
  // управляющий раз в 5 секунд рассылает, где видео у него, — у остальных не копится расхождение
  function beat() {
    if (!st?.vid || !st.playing || !isCtrl() || pstate() !== 1 || loadedId !== st.vid.src + st.vid.id) return;
    st.pos = curTime();
    recvAt = now();
    O.send({ t: 'sync', v: st.v, by: st.by, pos: st.pos });
  }

  function applyVolume() {
    for (const p of Object.values(players)) p?.volume(vol, deaf);
  }

  function unload() {
    timers.forEach(clearInterval);
    timers = [];
    for (const p of Object.values(players)) p?.destroy();
    for (const k of Object.keys(players) as Src[]) delete players[k];
    cur = null;
    loadedId = '';
    tile = null;
  }

  // ---------- разметка ----------
  function showPlayer(src: Src | null) {
    if (!tile) return;
    tile.querySelectorAll<HTMLElement>('.w-p').forEach((el) => el.classList.toggle('on', el.classList.contains('w-p-' + src)));
    tile.dataset.src = src || '';
  }

  function showError(text: string) {
    const el = tile?.querySelector<HTMLElement>('.yt-err');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function drawProgress() {
    const bar = tile?.querySelector<HTMLElement>('.au-prog');
    if (!bar || !st?.vid || st.vid.src !== 'au') return;
    const a = tile!.querySelector('audio')!;
    const d = Number.isFinite(a.duration) ? a.duration : 0, t = curTime();
    bar.querySelector<HTMLElement>('i')!.style.width = d ? Math.min(100, (t / d) * 100) + '%' : '0';
    bar.dataset.t = d ? `${fmtT(t)} / ${fmtT(d)}` : fmtT(t);
  }

  function mount(el: HTMLElement) {
    unload();
    tile = el;
    const { ic, esc } = O;
    el.classList.add('w-sess');
    el.innerHTML = `
      <div class="yt-bar">
        <span class="yt-logo">${ic('music', 22)}</span>
        <div class="yt-now"></div>
        <form class="yt-form"><input placeholder="Ссылка: YouTube, Spotify или mp3" spellcheck="false">
          <button class="btn sm" data-y="go"></button></form>
        <button class="ibtn w-own" data-y="pp" title="Пауза / играть">${ic('play', 20)}</button>
        <button class="ibtn w-own" data-y="next" title="Следующее из очереди">${ic('skip', 20)}</button>
        <button class="ibtn yt-qbtn" data-y="queue" title="Очередь">${ic('queue', 20)}<i></i></button>
        <label class="w-vol" title="Громкость (только у вас)">${ic('volume', 18)}<input type="range" min="0" max="100" value="${Math.round(vol * 100)}"></label>
        <button class="ibtn" data-y="close"></button>
      </div>
      <div class="yt-main">
        <div class="w-p w-p-yt yt-player"><div></div></div>
        <div class="w-p w-p-sp"><div></div></div>
        <div class="w-p w-p-au"><div class="au-cover">${ic('music', 64)}<b></b><span></span>
          <div class="au-prog" data-y="seek"><i></i></div></div><audio preload="auto"></audio></div>
        <div class="w-shield" hidden></div>
        <div class="yt-empty">${ic('music', 56)}<b>Смотрим и слушаем вместе</b>
          <span>Вставьте сверху ссылку на видео YouTube, трек Spotify или mp3 — его увидят и услышат все${O.place === 'call' ? ' в звонке' : ', кто слушает в этой беседе'}. Управляет тот, кто включил, остальные добавляют в очередь.</span>
          ${O.login ? `<span class="w-login">Чтобы Spotify играл треки целиком, а не 30 секунд, войдите в свой аккаунт:
            <button type="button" class="linkbtn" data-y="login" data-s="spotify">Войти в Spotify</button> ·
            <button type="button" class="linkbtn" data-y="login" data-s="youtube">Войти в YouTube</button></span>` : ''}</div>
        <div class="yt-err" hidden></div>
      </div>
      <div class="yt-q" hidden></div>`;
    const form = el.querySelector<HTMLFormElement>('.yt-form')!;
    const inp = form.querySelector('input')!;
    let busy = false;
    const add = async () => {
      const text = inp.value.trim();
      const p = parseItem(text);
      if (!p) return O.toast(!text ? 'Вставьте ссылку' : isSpotifyList(text) ? 'Пока можно только отдельный трек Spotify — откройте трек и скопируйте ссылку на него' : 'Это не похоже на ссылку на YouTube, трек Spotify или mp3');
      if (busy || !st) return;
      busy = true;
      const item: Item = { src: p.src, id: p.id, title: '', by: O.myName() };
      item.title = (await O.info(item).catch(() => '')) || (p.src === 'au' ? decodeURIComponent(p.id.split('/').pop()!.split('?')[0]) : SRC_NAME[p.src]);
      busy = false;
      if (!st?.on) return;
      inp.value = '';
      enqueue(item, p.t);
    };
    form.onsubmit = (e) => { e.preventDefault(); add(); };
    const volIn = el.querySelector<HTMLInputElement>('.w-vol input')!;
    volIn.oninput = () => {
      vol = Number(volIn.value) / 100;
      try { localStorage.setItem('wvol', String(vol)); } catch {}
      applyVolume();
    };
    el.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-y]');
      if (!b || !st) return;
      const i = Number(b.dataset.i);
      const own = isCtrl();
      switch (b.dataset.y) {
        case 'queue': { const q = el.querySelector<HTMLElement>('.yt-q')!; q.hidden = !q.hidden; return draw(); }
        case 'login': return O.login?.(b.dataset.s as 'spotify' | 'youtube');
        case 'close':
          if (own) return commit({ on: false, vid: null, queue: [], playing: false, pos: 0 });
          return O.leave?.();
        case 'pp': return own && st.vid ? commit({ playing: !st.playing }) : undefined;
        case 'next': return own ? (st.queue.length ? next() : O.toast('Очередь пуста')) : undefined;
        case 'qplay': return own && st.queue[i] ? commit({ vid: st.queue[i], queue: st.queue.filter((_, k) => k !== i), playing: true, pos: 0 }) : undefined;
        case 'qdel': return own ? commit({ queue: st.queue.filter((_, k) => k !== i) }) : undefined;
        case 'seek': {
          if (!own || !st.vid || st.vid.src !== 'au') return;
          const a = el.querySelector('audio')!;
          const r = b.getBoundingClientRect();
          if (Number.isFinite(a.duration)) commit({ pos: Math.max(0, Math.min(1, ((e as MouseEvent).clientX - r.left) / r.width)) * a.duration });
          return;
        }
      }
    };
    timers.push(window.setInterval(tick, 1000), window.setInterval(beat, 5000));
    draw();
    syncPlayer();
  }

  // добавить: управляющий — сразу (если ничего не играет — включается); остальные — просьбой
  function enqueue(item: Item, at = 0) {
    if (!st?.on) return;
    if (isCtrl()) {
      if (!st.vid) return commit({ vid: item, playing: true, pos: at });
      if (st.queue.length >= MAX_QUEUE) return O.toast(`В очереди не больше ${MAX_QUEUE} треков и видео`);
      commit({ queue: [...st.queue, item] });
      return O.toast(`«${item.title}» — в очереди`);
    }
    O.send({ t: 'add', item, from: O.me() });
    O.toast(st.vid ? `«${item.title}» — в очереди` : `Включаем «${item.title}»`);
  }

  function draw() {
    if (!tile || !st) return;
    const { esc, ic } = O;
    const v = st.vid;
    const own = isCtrl();
    const boss = ctrlId();
    tile.classList.toggle('w-owner', own);
    tile.querySelector('.yt-now')!.innerHTML = v
      ? `<b title="${esc(v.title)}">${esc(v.title)}</b><span>${SRC_NAME[v.src]} · включил(а) ${esc(v.by)}${!own && boss ? ` · управляет ${esc(O.nameOf(boss))}` : ''}</span>`
      : `<b>Ничего не играет</b><span>${own ? 'Вы управляете' : boss ? 'Управляет ' + esc(O.nameOf(boss)) : ''}</span>`;
    tile.querySelector<HTMLElement>('.yt-empty')!.hidden = !!v;
    const shield = tile.querySelector<HTMLElement>('.w-shield')!;
    shield.hidden = own || !v;
    shield.title = boss ? `Видео переключает и ставит на паузу ${O.nameOf(boss)}. Вы можете добавить своё в очередь.` : '';
    tile.querySelector<HTMLElement>('[data-y="go"]')!.textContent = own && !v ? 'Включить' : 'В очередь';
    tile.querySelector<HTMLElement>('[data-y="pp"]')!.innerHTML = ic(st.playing ? 'pause' : 'play', 20);
    tile.querySelector<HTMLButtonElement>('[data-y="pp"]')!.disabled = !v;
    tile.querySelector<HTMLButtonElement>('[data-y="next"]')!.disabled = !st.queue.length;
    const close = tile.querySelector<HTMLElement>('[data-y="close"]')!;
    close.hidden = !own && !O.leave;
    close.title = own ? 'Закрыть у всех' : 'Выйти — перестать слушать';
    close.innerHTML = ic(own ? 'close' : 'leave', 20);
    tile.querySelector('.yt-qbtn i')!.textContent = st.queue.length ? String(st.queue.length) : '';
    const cover = tile.querySelector('.au-cover');
    if (cover && v?.src === 'au') { cover.querySelector('b')!.textContent = v.title; cover.querySelector('span')!.textContent = 'включил(а) ' + v.by; }
    const q = tile.querySelector<HTMLElement>('.yt-q')!;
    if (!q.hidden) q.innerHTML = `<h5>Очередь — ${st.queue.length}</h5>` + (st.queue.map((x, i) => `
      <div class="yt-qi">${thumbOf(x) ? `<img src="${thumbOf(x)}" alt="" draggable="false">` : `<span class="yt-qic">${ic('music', 22)}</span>`}
        <div><b title="${esc(x.title)}">${esc(x.title)}</b><span>${SRC_NAME[x.src]} · добавил(а) ${esc(x.by)}</span></div>
        ${own ? `<button class="ibtn" data-y="qplay" data-i="${i}" title="Включить сейчас">${ic('play', 18)}</button>
        <button class="ibtn" data-y="qdel" data-i="${i}" title="Убрать из очереди">${ic('close', 18)}</button>` : ''}</div>`).join('')
      || '<p>Пусто. Вставьте ссылку сверху — видео или трек включится следом.</p>');
    drawProgress();
  }

  return {
    on: () => !!st?.on,
    state: () => st,
    isCtrl,
    onData,
    mount,
    draw,
    // начать: я включил — я и управляю
    start(first?: Item) {
      if (st?.on) { if (first) enqueue(first); return; }
      commit({ on: true, owner: O.me(), vid: first ?? null, queue: [], playing: !!first, pos: 0 });
    },
    enqueue,
    // новичку — что играет и где сейчас (отвечает главный)
    joined(id: string) {
      if (!st || !O.leader(id)) return;
      O.send({ t: 'state', s: { ...st, pos: st.vid && st.playing ? curTime() : st.pos } }, [id]);
    },
    // ушёл управляющий — главный из оставшихся берёт управление на себя
    left(id: string) {
      if (st?.on && st.owner === id && O.leader(id)) { commit({ owner: O.me() }); O.toast('Теперь вы управляете совместным просмотром'); }
      else draw();
    },
    reset() { st = null; unload(); },
    deafen(on: boolean) {
      deaf = on;
      applyVolume();
      if (cur === 'sp') { on ? pl()?.pause() : syncPlayer(); } // у Spotify нет «без звука» — ставим у себя на паузу
    },
    unload,
  };
}
