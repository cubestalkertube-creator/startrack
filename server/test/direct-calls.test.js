import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectCalls } from '../src/direct-calls.js';

test('a private call survives one participant leaving, permits rejoining and ends when empty', () => {
  const events = [];
  const calls = createDirectCalls((uid, event) => events.push({ uid, ...event }));
  const a = { uid: 1 }, b = { uid: 2 };
  calls.join(a, 2); calls.join(b, 1);
  calls.leave(b);
  assert.deepEqual(calls.users(1, 2), [1]);
  assert.deepEqual(calls.snapshot(2), [{ peer: 1, users: [1] }]);
  assert.deepEqual(events.slice(-2), [
    { uid: 2, type: 'dcall', peer: 1, users: [1] },
    { uid: 1, type: 'dcall', peer: 2, users: [1] },
  ]);
  calls.join(b, 1);
  assert.deepEqual(calls.users(2, 1), [1, 2]);
  calls.leave(a); calls.leave(b);
  assert.deepEqual(calls.users(1, 2), []);
  assert.deepEqual(calls.snapshot(1), []);
  assert.deepEqual(calls.snapshot(2), []);
  assert.deepEqual(events.at(-1).users, []);
});

test('a stale disconnected socket does not remove a new connection for the same user', () => {
  const calls = createDirectCalls(() => {});
  const old = { uid: 1 }, fresh = { uid: 1 }, peer = { uid: 2 };
  calls.join(old, 2); calls.join(peer, 1); calls.join(fresh, 2);
  calls.leave(old); calls.leave(old);
  assert.deepEqual(calls.users(1, 2), [2, 1]);
  calls.leave(peer);
  assert.deepEqual(calls.users(1, 2), [1]);
});

test('switching calls removes old presence and does not expose unrelated calls', () => {
  const calls = createDirectCalls(() => {});
  const a = { uid: 1 }, b = { uid: 2 }, c = { uid: 3 };
  calls.join(a, 2); calls.join(b, 1);
  calls.join(a, 3); calls.join(a, 3); calls.join(c, 1);
  assert.deepEqual(calls.snapshot(2), [{ peer: 1, users: [2] }]);
  assert.deepEqual(calls.snapshot(3), [{ peer: 1, users: [1, 3] }]);
  calls.leave(a); calls.leave(c);
  assert.deepEqual(calls.snapshot(3), []);
  assert.deepEqual(calls.users(1, 2), [2]);
});
