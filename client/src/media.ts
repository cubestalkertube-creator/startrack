type Opts = { esc(s: string): string; ic(n: string, size?: number): string; toast(s: string): void };
let O: Opts;
export function initMedia(o: Opts) { O = o; }
const time = (n: number) => Number.isFinite(n) ? Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0') : '0:00';
export function audioPlayer(id: string, url: string, name: string) {
  return `<div class="audio-player" data-fid="${O.esc(id)}"><audio src="${O.esc(url)}" preload="metadata"></audio>
    <button type="button" class="audio-toggle" title="Воспроизвести" aria-label="Воспроизвести ${O.esc(name)}">${O.ic('play', 22)}</button>
    <div class="audio-track"><input class="audio-seek" type="range" min="0" max="1000" value="0" aria-label="Позиция воспроизведения"><div class="audio-times"><span>0:00</span><span>0:00</span></div></div>
    <button type="button" class="ibtn audio-mute" title="Выключить звук" aria-label="Выключить звук">${O.ic('volume', 18)}</button>
    <input class="audio-volume" type="range" min="0" max="100" value="80" aria-label="Громкость"></div>`;
}
export function bindAudio(box: HTMLElement) {
  box.querySelectorAll<HTMLElement>('.audio-player').forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    const a = el.querySelector('audio')!, play = el.querySelector<HTMLButtonElement>('.audio-toggle')!;
    const seek = el.querySelector<HTMLInputElement>('.audio-seek')!, vol = el.querySelector<HTMLInputElement>('.audio-volume')!;
    const mute = el.querySelector<HTMLButtonElement>('.audio-mute')!;
    a.volume = .8;
    const draw = () => {
      play.innerHTML = O.ic(a.paused ? 'play' : 'pause', 22);
      play.title = a.paused ? 'Воспроизвести' : 'Пауза'; play.setAttribute('aria-label', play.title);
      el.classList.toggle('playing', !a.paused);
      if (document.activeElement !== seek) seek.value = String(a.duration ? a.currentTime / a.duration * 1000 : 0);
      seek.disabled = !Number.isFinite(a.duration) || !a.duration;
      seek.style.setProperty('--progress', Number(seek.value) / 10 + '%');
      el.querySelector('.audio-times span')!.textContent = time(a.currentTime);
      el.querySelector('.audio-times span:last-child')!.textContent = time(a.duration);
      mute.innerHTML = O.ic(a.muted || !a.volume ? 'deaf' : 'volume', 18);
      mute.title = a.muted ? 'Включить звук' : 'Выключить звук'; mute.setAttribute('aria-label', mute.title);
    };
    play.onclick = () => { if (a.paused) a.play().catch(() => O.toast('Не удалось воспроизвести аудио')); else a.pause(); };
    mute.onclick = () => { a.muted = !a.muted; draw(); };
    seek.oninput = () => { if (Number.isFinite(a.duration)) a.currentTime = Number(seek.value) / 1000 * a.duration; draw(); };
    vol.oninput = () => { a.volume = Number(vol.value) / 100; a.muted = false; draw(); };
    for (const ev of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange']) a.addEventListener(ev, draw);
    a.addEventListener('error', () => { play.disabled = true; play.title = 'Аудиофайл недоступен'; });
    draw();
  });
}
