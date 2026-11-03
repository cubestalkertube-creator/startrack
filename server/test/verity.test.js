import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initApps } from '../src/apps.js';

process.env.POLZA_API_KEY = 'local-test-key';
const { initVerity } = await import('../src/verity.js');
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1), (2)');
  const addColumn = (table, col, type) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {} };
  const apps = initApps(db);
  const { routes } = initVerity(db, { addColumn, push() {}, userFacts: () => [], apps });
  return { db, routes, apps };
}
const me = { id: 1 };
const call = (name, args = {}, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (tool_calls) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls } }] }), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(r, initial, done) {
  let state = initial;
  for (let i = 0; i < 300; i++) {
    if (done(state)) return state;
    await tick();
    state = await r['GET /api/verity/run'](me, {}, new URL(`http://x/?chat=${initial.chat.id}&turn=${initial.turn}&device=desktop`));
  }
  throw new Error('background task did not reach expected state');
}
test('background task passes 20 steps, retries a model failure, creates a draft and returns the same result on duplicate start', async () => {
  const { db, routes: r, apps } = setup();
  const original = globalThis.fetch;
  let n = 0, failed = false;
  globalThis.fetch = async () => {
    n++;
    if (n === 5 && !failed) { failed = true; throw new Error('simulated network failure'); }
    if (n <= 25) return response([call('create_app', { name: 'Игра ' + n, description: 'Тест', html: '<button>Играть</button>' }, 'repeated-provider-id')]);
    return response([call('answer', { reply: 'Готово', delta: 0, prank: 'none' })]);
  };
  try {
    const body = { chat: 0, text: 'Создай приложения', background: true, personality: false, requestId: 'same-request' };
    const start = await r['POST /api/verity'](me, body);
    assert.equal(start.running, true);
    const again = await r['POST /api/verity'](me, body);
    assert.equal(start.chat.id, again.chat.id);
    const end = await until(r, start, (s) => s.message);
    assert.equal(end.message.text, 'Готово');
    assert.equal(end.message.steps.length, 24);
    assert.equal(end.message.steps.every((s) => s.app && s.ok), true);
    assert.equal((await apps.routes['GET /api/apps'](me)).apps.every((a) => !a.published), true);
    const duplicate = await r['POST /api/verity'](me, body);
    assert.equal(duplicate.message.id, end.message.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verity_chats').get().n, 1);
    await assert.rejects(r['GET /api/verity/run']({ id: 2 }, {}, new URL(`http://x/?chat=${start.chat.id}&turn=${start.turn}`)), (e) => e[0] === 404);
  } finally { globalThis.fetch = original; db.close(); }
});

test('computer continuation is idempotent and stores visible file changes', async () => {
  const { db, routes: r } = setup();
  const original = globalThis.fetch;
  let n = 0, release;
  globalThis.fetch = async () => ++n === 1 ? response([call('write_file', { path: 'game.html', content: '<h1>Игра</h1>' })]) : await new Promise((resolve) => { release = () => resolve(response([call('answer', { reply: 'Готово', delta: 0 })])); });
  try {
    const start = await r['POST /api/verity'](me, { chat: 0, text: 'Сделай игру', background: true, personality: false, device: 'desktop', pc: true, ctx: { ws: 'D:/Verity' } });
    const pending = await until(r, start, (s) => s.pending);
    const phone = await r['GET /api/verity/run'](me, {}, new URL(`http://x/?chat=${start.chat.id}&device=phone`));
    assert.equal(phone.pending, undefined, 'another device must not execute desktop actions');
    assert.equal(phone.running, true);
    const body = { chat: start.chat.id, turn: start.turn, device: 'desktop', results: [{ id: pending.pending.calls[0].id, ok: true, out: 'Записано' }] };
    await assert.rejects(r['POST /api/verity/continue'](me, { ...body, device: 'phone' }), (e) => e[0] === 403);
    await r['POST /api/verity/continue'](me, body);
    const dup = await r['POST /api/verity/continue'](me, body);
    assert.equal(dup.steps.length, 1);
    assert.equal(dup.steps[0].after, '<h1>Игра</h1>');
    release();
    const end = await until(r, start, (s) => s.message);
    assert.equal(end.message.steps.length, 1);
  } finally { globalThis.fetch = original; db.close(); }
});

test('permanent model configuration errors finish promptly instead of retrying for an hour', async () => {
  const { db, routes: r } = setup();
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }); };
  try {
    const start = await r['POST /api/verity'](me, { chat: 0, text: 'Проверка', background: true, personality: false });
    const end = await until(r, start, (s) => s.message);
    assert.equal(n, 1);
    assert.match(end.message.text, /настройки модели/);
  } finally { globalThis.fetch = original; db.close(); }
});

test('stop aborts an in-flight model request and never writes a second answer', async () => {
  const { db, routes: r } = setup();
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const start = await r['POST /api/verity'](me, { chat: 0, text: 'Работай', background: true, personality: false });
    const stopped = await r['POST /api/verity/stop'](me, { chat: start.chat.id });
    assert.equal(signal.aborted, true);
    await tick();
    const end = await until(r, start, (s) => s.message);
    assert.equal(end.message.id, stopped.message.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verity WHERE role = 'verity'").get().n, 1);
  } finally { globalThis.fetch = original; db.close(); }
});
