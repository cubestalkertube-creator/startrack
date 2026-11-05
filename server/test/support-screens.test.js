import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportScreens } from '../src/support-screens.js';

const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const status = (code) => (e) => Array.isArray(e) && e[0] === code;

test('diagnostic screens require a request and exclusive publisher, isolate users and clear frames on stop', (t) => {
  const events = [], screens = createSupportScreens((...e) => events.push(e));
  t.after(screens.dispose);
  assert.throws(() => screens.start(1, ''), status(404));
  const r = screens.request(1);
  assert.equal(events[0][1].mode, 'support');
  assert.throws(() => screens.request(1), status(409));
  assert.throws(() => screens.start(2, r.request), status(404));
  assert.throws(() => screens.start(1, ''), status(404));
  assert.throws(() => screens.frame(1, { request: r.request, frame: jpeg }), status(403));
  const publisher = screens.start(1, r.request).publisher;
  assert.throws(() => screens.start(1, r.request), status(409));
  assert.throws(() => screens.frame(1, { request: r.request, publisher: 'wrong', frame: jpeg }), status(403));
  assert.throws(() => screens.frame(1, { request: r.request, publisher, frame: 'data:image/svg+xml;base64,PHN2Zz4=' }), status(400));
  screens.frame(1, { request: r.request, publisher, frame: jpeg });
  const v = screens.view(1, r.request, 0);
  assert.equal(v.frame, jpeg);
  assert.equal(v.version, 1);
  assert.equal(screens.view(1, r.request, 1).frame, '', 'unchanged frames are not transferred again');
  assert.ok(!('publisher' in v), 'viewer cannot claim publisher credentials');
  assert.throws(() => screens.finish(1, { request: r.request }), status(403), 'another device cannot cancel an accepted request');
  screens.finish(1, { request: r.request, publisher });
  assert.equal(events.at(-1)[1].type, 'admin_screen_stop');
  assert.throws(() => screens.view(1, r.request, 0), status(404));
  const fresh = screens.request(1);
  assert.notEqual(fresh.request, r.request);
  assert.throws(() => screens.finish(1, { request: r.request, publisher }), status(404));
  assert.equal(screens.view(1, fresh.request, 0).status, 'pending');
});

test('diagnostic screens stop when the viewer disappears, frames stall or maximum duration passes', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const screens = createSupportScreens(() => {});
  t.after(screens.dispose);
  let r = screens.request(1);
  t.mock.timers.tick(15001);
  assert.throws(() => screens.start(1, r.request), status(410), 'no administrator viewer');
  r = screens.request(1);
  screens.start(1, r.request);
  t.mock.timers.tick(10000);
  screens.view(1, r.request, 0);
  t.mock.timers.tick(5001);
  assert.throws(() => screens.view(1, r.request, 0), status(410), 'publisher stopped sending frames');
  r = screens.request(1);
  screens.start(1, r.request);
  t.mock.timers.tick(600001);
  assert.throws(() => screens.view(1, r.request, 0), status(410));
});
