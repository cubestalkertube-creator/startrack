import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTyping } from '../src/typing.js';

test('typing expires, aggregates devices, stops on messages and disconnects', async () => {
  const events = [], typing = createTyping((...args) => events.push(args), 40);
  const a = { uid: 1 }, second = { uid: 1 }, b = { uid: 2 };
  const dm = { key: 'dm_1_2', peer: 2 }, group = { key: 'grp_3', group: 3 };
  typing.set(a, dm, true);
  typing.set(a, dm, true);
  typing.set(second, dm, true);
  assert.deepEqual(events, [[1, dm, true]], 'duplicate updates are throttled across devices');
  typing.leave(a);
  assert.equal(events.length, 1, 'closing one device must not hide another typing device');
  typing.set(b, group, true);
  typing.stop(1, dm);
  assert.deepEqual(events.at(-1), [1, dm, false], 'sending a message stops all devices in that conversation');
  await delay(80);
  assert.deepEqual(events.at(-1), [2, group, false], 'abandoned input expires');
  typing.set(a, dm, true);
  typing.leave(a);
  assert.deepEqual(events.at(-1), [1, dm, false]);
});
