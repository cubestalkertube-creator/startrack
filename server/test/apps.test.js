import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initApps } from '../src/apps.js';

test('drafts stay private; publishing exposes an immutable application by its unique command', async () => {
  const db = new DatabaseSync(':memory:');
  const { routes: r } = initApps(db);
  const author = { id: 1 }, friend = { id: 2 };
  const one = await r['POST /api/apps/save'](author, { name: 'Моя игра', html: '<h1>Игра</h1>' });
  const two = await r['POST /api/apps/save'](friend, { name: 'Моя игра', html: '<h1>Другая</h1>' });
  assert.notEqual(one.slug, two.slug);
  assert.equal(one.html, undefined, 'list responses must not ship executable code');
  const get = (who, id) => r['GET /api/apps/get'](who, {}, new URL('http://x/?id=' + id));
  await assert.rejects(get(friend, one.id), (e) => e[0] === 404);
  await assert.rejects(r['POST /api/apps/publish'](friend, { id: one.id }), (e) => e[0] === 404);
  const info = await r['POST /api/apps/publish'](author, { id: one.id, name: 'Готовая игра' });
  assert.match(info.slug, /^готовая-игра-/);
  const published = await get(friend, info.slug);
  assert.equal(published.name, 'Готовая игра');
  assert.equal(published.html, '<h1>Игра</h1>');
  await assert.rejects(r['POST /api/apps/save'](author, { ...one, html: 'replacement' }), (e) => e[0] === 409);
  await assert.rejects(r['POST /api/apps/delete'](friend, { id: one.id }), (e) => e[0] === 403);
  assert.equal((await r['GET /api/apps'](friend)).apps.length, 1);
  await r['POST /api/apps/delete'](author, { id: one.id });
  await assert.rejects(get(friend, info.slug), (e) => e[0] === 404);
  db.close();
});

test('application limits use UTF-8 byte size and reject empty source or name', () => {
  const db = new DatabaseSync(':memory:');
  const { save } = initApps(db), me = { id: 1 };
  assert.throws(() => save(me, { name: ' ', html: 'x' }), (e) => e[0] === 400);
  assert.throws(() => save(me, { name: 'Игра', html: ' ' }), (e) => e[0] === 400);
  assert.throws(() => save(me, { name: 'Игра', html: 'я'.repeat(500001) }), (e) => e[0] === 413);
  db.close();
});
