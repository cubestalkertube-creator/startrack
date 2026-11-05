import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Conversation identifiers are canonical on the server; clients use their peer's id.
export function initChatFeatures({ db, q, isFriend, isMember, memberIds, push, pushGroup, filesDir, postFile, verify }) {
  const column = (table, name, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  column('messages', 'reply', 'INTEGER');
  column('files', 'media', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS message_reads (conv TEXT NOT NULL, uid INTEGER NOT NULL, last INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conv,uid));
    CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, uid INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS stickers_uid ON stickers(uid);`);
  const message = db.prepare('SELECT m.*, u.username AS name, f.name AS fname FROM messages m LEFT JOIN users u ON u.id=m.sender LEFT JOIN files f ON f.id=m.file WHERE m.id=?');
  const setReply = db.prepare('UPDATE messages SET reply=? WHERE id=?');
  const reads = db.prepare('SELECT uid,last FROM message_reads WHERE conv=?');
  const saveRead = db.prepare('INSERT INTO message_reads(conv,uid,last) VALUES(?,?,?) ON CONFLICT(conv,uid) DO UPDATE SET last=MAX(last,excluded.last)');
  const list = db.prepare('SELECT id,name,type,size FROM stickers WHERE uid=? ORDER BY created DESC');
  const getSticker = db.prepare('SELECT * FROM stickers WHERE id=? AND uid=?');
  const stickerDir = path.join(filesDir, '..', 'stickers');
  fs.mkdirSync(stickerDir, { recursive: true });
  const target = (me, b) => {
    const group = Number(b.group) || 0, peer = group ? 0 : Number(b.peer);
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(peer) || group < 0 || peer < 0) throw [400, 'Неверная беседа'];
    if (group ? !isMember(group, me.id) : !isFriend(me.id, peer)) throw [404, 'Беседа не найдена'];
    return { group, peer, conv: group ? 'g' + group : 'd' + [me.id, peer].sort((a,b) => a-b).join('-') };
  };
  const inConv = (m, me, t) => m && (t.group ? m.grp === t.group : !m.grp && ((m.sender === me.id && m.recipient === t.peer) || (m.sender === t.peer && m.recipient === me.id)));
  function validateReply(me, peer, group, id) {
    if (id == null || id === '') return null;
    const m = message.get(Number(id));
    if (!Number.isSafeInteger(Number(id)) || !inConv(m, me, {peer, group}) || m.kind) throw [400, 'Сообщение для ответа не найдено в этой беседе'];
    return m.id;
  }
  function decorate(m) {
    if (!m) return m;
    const id = m.reply ?? message.get(m.id)?.reply;
    if (!id) return m;
    const original = message.get(id);
    return { ...m, reply: original ? { id, sender: original.sender, name: original.name, text: original.text || original.fname || 'Вложение' } : { id, deleted: true, text: 'Сообщение удалено' } };
  }
  function attachReply(m, id) {
    if (id) setReply.run(id, m.id);
    return decorate(m);
  }
  const routes = {
    'GET /api/conversations': async me => {
      const convs = q.relsOf.all(me.id, me.id, me.id).filter(u => u.rel === 'accepted').map(u => ({ peer: u.id }));
      convs.push(...q.groupsOf.all(me.id).map(g => ({group:g.id})));
      return convs.map(b => {
        const t = target(me,b);
        const where = t.group ? 'grp=?' : 'grp IS NULL AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))';
        const args = t.group ? [t.group] : [me.id,t.peer,t.peer,me.id];
        const last = db.prepare(`SELECT MAX(id) AS id FROM messages WHERE ${where}`).get(...args).id || 0;
        const read = reads.all(t.conv).find(r => r.uid === me.id)?.last || 0;
        const unread = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE (${where}) AND id>? AND sender!=? AND kind IS NULL`).get(...args,read,me.id).n;
        return { key: t.group ? 'g'+t.group : 'u'+t.peer, last, unread };
      });
    },
    'GET /api/messages/reads': async (me, _b, url) => reads.all(target(me,Object.fromEntries(url.searchParams)).conv),
    'POST /api/messages/read': async (me,b) => {
      const t = target(me,b), m = message.get(Number(b.id));
      if (!inConv(m,me,t)) throw [400,'Сообщение не найдено в этой беседе'];
      saveRead.run(t.conv,me.id,m.id);
      const last = reads.all(t.conv).find(r => r.uid === me.id).last;
      const event = { type:'message_read', user:me.id, id:last, group:t.group, a:me.id, b:t.peer };
      if (t.group) pushGroup(t.group,event); else { push(me.id,event); push(t.peer,event); }
      return {ok:true,last};
    },
    'GET /api/stickers': async me => list.all(me.id),
    'POST /api/stickers/delete': async (me,b) => {
      const s = getSticker.get(String(b.id),me.id);
      if (!s) throw [404,'Стикер не найден'];
      db.prepare('DELETE FROM stickers WHERE id=? AND uid=?').run(s.id,me.id);
      fs.rmSync(path.join(stickerDir,s.id),{force:true});
      return list.all(me.id);
    },
    'POST /api/stickers/send': async (me,b) => {
      const t = target(me,b), reply = validateReply(me,t.peer,t.group,b.reply);
      const s = getSticker.get(String(b.id),me.id);
      if (!s) throw [404,'Стикер не найден'];
      const id = crypto.randomBytes(16).toString('hex');
      fs.copyFileSync(path.join(stickerDir,s.id),path.join(filesDir,id));
      return postFile(me,t.peer,t.group,{id,name:s.name,size:s.size,type:s.type,w:null,h:null,media:'sticker'},reply);
    },
  };
  async function raw(req,res,url,send) {
    if (!url.pathname.startsWith('/api/stickers/')) return false;
    const match = /^\/api\/stickers\/([0-9a-f]{32})$/.exec(url.pathname);
    const me = verify((req.headers.authorization || '').replace('Bearer ','') || url.searchParams.get('token'));
    if (match && req.method === 'GET') {
      const s = me && getSticker.get(match[1],me.id);
      if (!s) send(404,{error:'Стикер не найден'});
      else { res.writeHead(200,{'Content-Type':s.type,'Content-Length':s.size,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=86400'}); fs.createReadStream(path.join(stickerDir,s.id)).pipe(res); }
      return true;
    }
    if (url.pathname !== '/api/stickers/upload' || req.method !== 'POST') return false;
    if (!me) { send(401,{error:'Нужно войти'}); return true; }
    const type = req.headers['content-type'], size = Number(req.headers['content-length']);
    if (!['image/png','image/webp','image/jpeg','image/gif'].includes(type)) { send(415,{error:'Нужна картинка PNG, WebP, JPEG или GIF'}); return true; }
    if (!size || size > 2*1024*1024) { send(413,{error:'Стикер должен быть от 1 байта до 2 МБ'}); return true; }
    if (list.all(me.id).length >= 200) { send(400,{error:'Можно сохранить до 200 стикеров'}); return true; }
    const chunks=[]; let got=0;
    for await (const chunk of req) { got+=chunk.length; if(got>size) break; chunks.push(chunk); }
    if(got!==size) {send(400,{error:'Загрузка прервалась'});return true;}
    const data=Buffer.concat(chunks), sig=data.subarray(0,12).toString('latin1');
    const magic={'image/png':/^\x89PNG\r\n\x1a\n/,'image/jpeg':/^\xff\xd8\xff/,'image/webp':/^RIFF....WEBP/s,'image/gif':/^GIF8[79]a/};
    if(!magic[type].test(sig)) {send(415,{error:'Файл не похож на картинку'});return true;}
    const id=crypto.randomBytes(16).toString('hex'), name=String(url.searchParams.get('name') || 'Стикер').slice(0,100);
    fs.writeFileSync(path.join(stickerDir,id),data);
    db.prepare('INSERT INTO stickers VALUES(?,?,?,?,?,?)').run(id,me.id,name,type,size,Date.now());
    send(200,list.all(me.id)); return true;
  }
  return { routes, decorate, attachReply, validateReply, raw };
}
