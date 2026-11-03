import crypto from 'node:crypto';

const MAX_HTML = 1_000_000;
export function initApps(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_apps (
    id TEXT PRIMARY KEY, owner INTEGER NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL, html TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, updated INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS chat_apps_owner ON chat_apps(owner, updated);`);
  const meta = (a) => { const { html, ...rest } = a; return rest; };
  function get(me, key) {
    const app = db.prepare('SELECT * FROM chat_apps WHERE id = ? OR slug = ?').get(key, key);
    if (!app || (!app.published && app.owner !== me.id)) throw [404, 'Приложение не найдено или ещё не опубликовано'];
    return app;
  }
  function save(me, b) {
    const name = String(b.name || '').trim().slice(0, 60);
    const html = String(b.html || '');
    if (!name || !html.trim()) throw [400, 'Укажите название и HTML приложения'];
    if (Buffer.byteLength(html) > MAX_HTML) throw [413, 'Приложение должно быть не больше 1 МБ'];
    let old;
    if (b.id) {
      old = get(me, String(b.id));
      if (old.owner !== me.id) throw [403, 'Менять приложение может только автор'];
      if (old.published) throw [409, 'Для новой версии создайте черновик: опубликованная версия уже отправлена людям'];
    }
    if (!old && db.prepare('SELECT COUNT(*) AS n FROM chat_apps WHERE owner = ?').get(me.id).n >= 100) throw [429, 'Можно создать до 100 приложений'];
    const id = old?.id || crypto.randomBytes(12).toString('hex');
    const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 36) || 'app';
    const slug = old?.slug || base + '-' + id.slice(0, 8);
    const now = Date.now();
    const description = String(b.description || '').trim().slice(0, 240);
    db.prepare(`INSERT INTO chat_apps (id, owner, name, slug, description, html, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, html=excluded.html, updated=excluded.updated`)
      .run(id, me.id, name, slug, description, html, now, now);
    return meta(get(me, id));
  }
  return { save, drop: (uid) => db.prepare('DELETE FROM chat_apps WHERE owner = ?').run(uid), routes: {
    'GET /api/apps': async (me) => ({ apps: db.prepare('SELECT * FROM chat_apps WHERE owner = ? ORDER BY updated DESC').all(me.id).map(meta) }),
    'GET /api/apps/get': async (me, _b, url) => get(me, String(url.searchParams.get('id') || '')),
    'GET /api/apps/info': async (me, _b, url) => meta(get(me, String(url.searchParams.get('id') || ''))),
    'POST /api/apps/save': async (me, b) => save(me, b),
    'POST /api/apps/publish': async (me, b) => {
      const app = get(me, String(b.id || ''));
      if (app.owner !== me.id) throw [403, 'Публиковать приложение может только автор'];
      if (b.name !== undefined && !String(b.name).trim()) throw [400, 'Укажите название'];
      const name = String(b.name || app.name).trim().slice(0, 60);
      const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 36) || 'app';
      const slug = app.published ? app.slug : base + '-' + app.id.slice(0, 8);
      db.prepare('UPDATE chat_apps SET published = 1, name = ?, slug = ?, updated = ? WHERE id = ?').run(name, slug, Date.now(), app.id);
      return meta(get(me, app.id));
    },
    'POST /api/apps/delete': async (me, b) => {
      const app = get(me, String(b.id || ''));
      if (app.owner !== me.id) throw [403, 'Удалять приложение может только автор'];
      db.prepare('DELETE FROM chat_apps WHERE id = ?').run(app.id);
      return { ok: true };
    },
  } };
}
