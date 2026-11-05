type Api = (path: string, body?: unknown, timeoutMs?: number) => Promise<any>;
type Session = { request: string; publisher: string; stream: MediaStream; video: HTMLVideoElement; timer: number; expires: number };

export function createSupportScreen(api: Api, confirm: (title: string, text: string, ok: string) => Promise<boolean>, toast: (text: string) => void) {
  let session: Session | null = null, pending = '';
  function stop(notify = true) {
    const request = session?.request || pending, publisher = session?.publisher;
    pending = '';
    if (session) {
      clearTimeout(session.timer);
      session.stream.getTracks().forEach((t) => t.stop());
      session.video.pause();
      session.video.srcObject = null;
      session = null;
    }
    document.getElementById('support-sharing')?.remove();
    if (notify && request) void api('/api/support/screen/stop', { request, publisher }, 5000).catch(() => {});
  }
  async function request(ev: { request: string; expires: number }) {
    if (session || pending || ev.expires < Date.now()) return;
    if (!navigator.mediaDevices?.getDisplayMedia) { toast('Демонстрация экрана на этом устройстве недоступна'); return; }
    pending = ev.request;
    let stream: MediaStream | null = null;
    try {
      const accepted = await confirm('Показать экран администратору?', 'Администратор просит показать экран для помощи с подключением. Входить в звонок не нужно. Видит только администратор; звук не передаётся. Выберите экран или окно. Показ можно остановить в любой момент.', 'Выбрать экран');
      if (pending !== ev.request) return;
      if (!accepted || ev.expires < Date.now()) { stop(); return; }
      // Capture is requested immediately after the user's click (transient activation).
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 4, max: 4 } }, audio: false });
      if (pending !== ev.request) { stream.getTracks().forEach((t) => t.stop()); return; }
      const result = await api('/api/support/screen/start', { request: ev.request }, 5000);
      if (pending !== ev.request) {
        stream.getTracks().forEach((t) => t.stop());
        void api('/api/support/screen/stop', { request: ev.request, publisher: result.publisher }).catch(() => {});
        return;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      const s: Session = { request: ev.request, publisher: result.publisher, stream, video, timer: 0, expires: result.expires };
      session = s;
      pending = '';
      stream.getVideoTracks()[0].addEventListener('ended', () => { if (session === s) stop(); }, { once: true });
      const bar = document.createElement('div');
      bar.id = 'support-sharing';
      bar.innerHTML = '<span><b>Экран виден администратору</b><small>Без звонка · без звука · до 4 кадров/с</small></span><button class="btn danger">Остановить показ</button>';
      bar.querySelector('button')!.onclick = () => stop();
      document.body.append(bar);
      await video.play();
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      let failures = 0;
      const send = async () => {
        if (session !== s) return;
        if (Date.now() > s.expires) { stop(); toast('Демонстрация завершена: прошло 10 минут'); return; }
        try {
          if (!video.videoWidth || !video.videoHeight) throw new Error('Нет кадров экрана');
          const scale = Math.min(1, 1600 / video.videoWidth, 900 / video.videoHeight);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          let frame = canvas.toDataURL('image/jpeg', 0.7);
          if (frame.length > 700000) frame = canvas.toDataURL('image/jpeg', 0.35);
          await api('/api/support/screen/frame', { request: s.request, publisher: s.publisher, frame }, 5000);
          failures = 0;
        } catch (err) {
          if (session !== s) return;
          if (++failures >= 3) { stop(); toast('Показ экрана остановлен: ' + (err as Error).message); return; }
        }
        if (session === s) s.timer = window.setTimeout(send, 250);
      };
      void send();
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      if (pending === ev.request || session?.request === ev.request) {
        stop();
        if ((err as Error).name !== 'NotAllowedError') toast('Показ экрана не запустился: ' + (err as Error).message);
      }
    }
  }
  window.addEventListener('beforeunload', () => stop());
  return { request, stop, get id() { return session?.request || pending; } };
}
