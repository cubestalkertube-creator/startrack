import crypto from 'node:crypto';

// Diagnostic screen sharing uses HTTPS, independently of LiveKit. Only the latest
// frame is kept in memory; it is discarded on stop, timeout or administrator exit.
export function createSupportScreens(push) {
  const sessions = new Map();
  function stop(uid) {
    const s = sessions.get(uid);
    if (!s) return;
    sessions.delete(uid);
    push(uid, { type: 'admin_screen_stop', request: s.request });
  }
  function get(uid, request) {
    const s = sessions.get(uid);
    if (!s || (request !== undefined && (!request || s.request !== request))) throw [404, 'Демонстрация завершена'];
    const now = Date.now();
    if (now > s.expires || now - s.viewed > 15000 || (s.status === 'active' && now - s.received > 15000)) {
      stop(uid);
      throw [410, 'Время демонстрации истекло'];
    }
    return s;
  }
  function request(uid) {
    if (sessions.has(uid)) {
      try { get(uid); throw [409, 'Запрос демонстрации уже открыт']; }
      catch (e) { if (e[0] !== 410) throw e; }
    }
    const now = Date.now();
    const s = { request: crypto.randomBytes(16).toString('hex'), status: 'pending', expires: now + 30000,
      viewed: now, received: now, publisher: '', frame: '', version: 0 };
    sessions.set(uid, s);
    push(uid, { type: 'admin_screen_request', mode: 'support', request: s.request, expires: s.expires });
    return { request: s.request, expires: s.expires };
  }
  function start(uid, request) {
    const s = get(uid, String(request || ''));
    if (s.status !== 'pending') throw [409, 'Демонстрация уже запущена на другом устройстве'];
    s.status = 'active';
    s.publisher = crypto.randomBytes(16).toString('hex');
    s.expires = Date.now() + 10 * 60e3;
    s.received = Date.now();
    return { publisher: s.publisher, expires: s.expires };
  }
  function owned(uid, request, publisher) {
    const s = get(uid, String(request || ''));
    if (s.status !== 'active' || !publisher || s.publisher !== publisher) throw [403, 'Демонстрация открыта на другом устройстве'];
    return s;
  }
  function frame(uid, b) {
    const s = owned(uid, b.request, b.publisher);
    if (typeof b.frame !== 'string' || b.frame.length > 700000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(b.frame)) throw [400, 'Неверный кадр'];
    const jpeg = Buffer.from(b.frame.slice(23), 'base64');
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw [400, 'Неверный JPEG'];
    if (Date.now() - s.received < 150 && s.version) throw [429, 'Слишком много кадров'];
    s.frame = b.frame;
    s.received = Date.now();
    s.version++;
    return { ok: true };
  }
  function view(uid, request, since) {
    const s = get(uid, request);
    s.viewed = Date.now();
    return { request: s.request, status: s.status, expires: s.expires, version: s.version,
      frame: Number(since) === s.version ? '' : s.frame };
  }
  function finish(uid, b) {
    const s = get(uid, String(b.request || ''));
    if (s.status === 'active') owned(uid, b.request, b.publisher);
    stop(uid);
    return { ok: true };
  }
  const timer = setInterval(() => {
    for (const uid of sessions.keys()) { try { get(uid); } catch {} }
  }, 1000);
  timer.unref();
  return { request, start, frame, view, finish, stop, dispose: () => { clearInterval(timer); for (const uid of sessions.keys()) stop(uid); } };
}
