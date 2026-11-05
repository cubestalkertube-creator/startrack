import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('admin profile edits, image moderation, voice permissions and consent requests', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startrack-admin-'));
  // Prevent background network refresh in this isolated API process.
  fs.writeFileSync(path.join(dir, 'detectable.json'), '[]');
  const adminToken = 'isolated-admin-test-token';
  const port = await freePort(), adminPort = await freePort();
  const rpc = [];
  let lkDown = false, participants = [];
  const livekit = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}'), method = req.url.split('/').at(-1);
    rpc.push({ method, ...body });
    res.setHeader('Content-Type', 'application/json');
    if (lkDown) { res.writeHead(400); return res.end(JSON.stringify({ code: 'unavailable', msg: 'test outage' })); }
    const result = method === 'ListRooms' ? { rooms: [{ name: 'dm_1_2' }, { name: 'unrelated' }] }
      : method === 'ListParticipants' ? { participants }
      : method === 'UpdateParticipant' ? { identity: body.identity, permission: body.permission }
      : method === 'MutePublishedTrack' ? { track: { sid: body.trackSid, muted: body.muted } } : {};
    res.end(JSON.stringify(result));
  });
  const lkPort = await listen(livekit);
  let child, logs = '', ws, friendWs, strangerWs;
  const start = async () => {
    child = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_PORT: String(adminPort),
      DATA_DIR: dir, ADMIN_TOKEN: adminToken, APP_SECRET: 'isolated-test-secret',
      LIVEKIT_API_HOST: `http://127.0.0.1:${lkPort}`, LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (s) => { logs += s; });
    child.stderr.on('data', (s) => { logs += s; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`http://127.0.0.1:${adminPort}/`)).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('API did not start: ' + logs);
  };
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  t.after(async () => {
    ws?.terminate(); friendWs?.terminate(); strangerWs?.terminate(); await stop();
    await new Promise((resolve) => livekit.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const request = async (admin, route, body, token = admin ? adminToken : '', headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${admin ? adminPort : port}${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
      }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const admin = async (route, body) => {
    const r = await request(true, route, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const a = (await request(false, '/api/register', { username: 'test_author', password: 'test-password' })).data;
  const b = (await request(false, '/api/register', { username: 'test_friend', password: 'test-password' })).data;
  const id = a.user.id;
  assert.equal((await request(true, '/api/user/profile', { id, display: 'unauthorized' }, a.token)).status, 401);
  assert.equal((await request(false, '/api/user/profile', { id, display: 'unauthorized' }, a.token)).status, 404);
  assert.equal((await request(true, '/api/user/image?id=' + id, Buffer.from('GIF89a'), a.token, { 'Content-Type': 'image/gif' })).status, 401);
  assert.equal((await request(false, '/api/friends/request', { username: b.user.username }, a.token)).status, 200);
  assert.equal((await request(false, '/api/friends/accept', { userId: id }, b.token)).status, 200);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${a.token}`);
  friendWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${b.token}`);
  const events = [], friendEvents = [];
  ws.on('message', (s) => events.push(JSON.parse(s)));
  friendWs.on('message', (s) => friendEvents.push(JSON.parse(s)));
  await Promise.all([once(ws, 'open'), once(friendWs, 'open')]);
  await t.test('typing stays inside authorized conversations and calls keep their last participant', async () => {
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
      assert.fail('Expected realtime event did not arrive');
    };
    const c = (await request(false, '/api/register', { username: 'test_stranger', password: 'test-password' })).data;
    strangerWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${c.token}`);
    const strangerEvents = [];
    strangerWs.on('message', (s) => strangerEvents.push(JSON.parse(s)));
    await once(strangerWs, 'open');
    const send = (socket, event) => socket.send(JSON.stringify(event));
    send(ws, { type: 'typing', peer: b.user.id, user: c.user.id, active: true });
    await waitFor(() => friendEvents.some((e) => e.type === 'typing' && e.active));
    assert.deepEqual(friendEvents.findLast((e) => e.type === 'typing'), { type: 'typing', conv: 'u' + id, user: id, active: true });
    await request(false, '/api/dm/messages', { peer: b.user.id, text: 'typing stops on send' }, a.token);
    await waitFor(() => friendEvents.findLast((e) => e.type === 'typing')?.active === false);
    const group = (await request(false, '/api/groups/create', { users: [b.user.id], name: 'Realtime test' }, a.token)).data;
    send(ws, { type: 'typing', group: group.id, active: true });
    await waitFor(() => friendEvents.some((e) => e.type === 'typing' && e.conv === 'g' + group.id && e.active));
    send(strangerWs, { type: 'typing', peer: id, active: true });
    send(strangerWs, { type: 'typing', group: group.id, active: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!strangerEvents.some((e) => e.type === 'typing'));
    assert.ok(!events.some((e) => e.type === 'typing' && e.user === c.user.id), 'strangers cannot signal into a DM or group');
    send(friendWs, { type: 'typing', group: group.id, active: true });
    await waitFor(() => events.some((e) => e.type === 'typing' && e.user === b.user.id && e.active));
    await request(false, '/api/groups/remove', { group: group.id, user: b.user.id }, a.token);
    await waitFor(() => events.findLast((e) => e.type === 'typing' && e.user === b.user.id)?.active === false);
    // Clear the remaining draft, then use a fresh two-member group for calls.
    send(ws, { type: 'typing', group: group.id, active: false });
    const voice = (await request(false, '/api/groups/create', { users: [b.user.id] }, a.token)).data;
    const lastCall = () => events.findLast((e) => e.type === 'gcall' && e.group === voice.id)?.users;
    send(ws, { type: 'gcall_join', group: voice.id, ring: false });
    send(friendWs, { type: 'gcall_join', group: voice.id, ring: false });
    await waitFor(() => lastCall()?.length === 2);
    send(ws, { type: 'gcall_leave', group: voice.id });
    await waitFor(() => lastCall()?.length === 1);
    assert.deepEqual(lastCall(), [b.user.id]);
    assert.deepEqual((await request(false, '/api/groups', undefined, a.token)).data.find((g) => g.id === voice.id).call, [b.user.id]);
    send(ws, { type: 'gcall_join', group: voice.id, ring: false });
    await waitFor(() => lastCall()?.length === 2);
    send(friendWs, { type: 'gcall_leave', group: voice.id });
    send(ws, { type: 'gcall_leave', group: voice.id });
    await waitFor(() => lastCall()?.length === 0);
  });
  let card = await admin('/api/user/profile', { id, username: 'новый.ник', display: '  New\n Name  ', bio: 'Bio\n\n\ntext',
    pronouns: 'they', custom: 'Status', bcolor: '#aabbcc', status: 'dnd' });
  assert.equal(card.username, 'новый.ник');
  assert.equal(card.display, 'New Name');
  assert.equal(card.bio, 'Bio\n\ntext');
  assert.equal(card.status, 'dnd');
  assert.equal((await request(false, '/api/me', undefined, a.token)).data.username, 'новый.ник');
  assert.equal((await request(false, '/api/login', { username: 'новый.ник', password: 'test-password' })).status, 200);
  for (const [body, status] of [[{ username: b.user.username }, 409], [{ username: 'bad nick' }, 400], [{ bcolor: 'red' }, 400], [{ status: 'bogus' }, 400]]) {
    assert.equal((await request(true, '/api/user/profile', { id, display: 'must not save', ...body })).status, status);
    assert.equal((await admin('/api/user?id=' + id)).display, 'New Name');
  }
  assert.equal((await request(true, '/api/user/profile', { id: 999999, bio: 'x' })).status, 404);
  const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  for (const kind of ['avatar', 'banner']) {
    const upload = await request(true, `/api/user/image?id=${id}&kind=${kind}`, image, adminToken, { 'Content-Type': 'image/gif' });
    assert.equal(upload.status, 200);
    const name = upload.data[kind];
    assert.match(name, /^[a-f0-9]{32}\.gif$/);
    assert.ok(fs.existsSync(path.join(dir, 'avatars', name)));
    assert.equal((await request(true, `/api/user/image?id=${id}&kind=${kind}`, Buffer.from('bad image'), adminToken, { 'Content-Type': 'image/gif' })).status, 415);
    await admin('/api/user/profile', { id, [kind]: null });
    assert.equal(fs.existsSync(path.join(dir, 'avatars', name)), false);
  }
  participants = [{ identity: String(id), name: 'test_author', tracks: [{ sid: 'TR_mic', source: 'MICROPHONE', muted: false }, { sid: 'TR_screen', source: 'SCREEN_SHARE' }] }];
  card = await admin('/api/user/voice', { id, muted: true });
  assert.equal(card.voice_muted, 1);
  assert.equal(card.voice_warning, '');
  assert.equal((await request(false, '/api/me', undefined, a.token)).data.voiceMuted, true);
  assert.equal((await request(false, '/api/me/profile', { voice_muted: 0 }, a.token)).data.voiceMuted, true);
  assert.equal((await request(true, '/api/user/voice', { id, muted: 'false' })).status, 400);
  const permission = rpc.findLast((r) => r.method === 'UpdateParticipant').permission;
  assert.deepEqual(permission.canPublishSources, ['CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);
  assert.ok(rpc.some((r) => r.method === 'MutePublishedTrack' && r.trackSid === 'TR_mic' && r.muted === true));
  assert.ok(!rpc.some((r) => r.room === 'unrelated'));
  const beforeSweep = rpc.length;
  for (let i = 0; i < 120 && !rpc.slice(beforeSweep).some((r) => r.method === 'UpdateParticipant'); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(rpc.slice(beforeSweep).some((r) => r.method === 'UpdateParticipant'), 'stale token reconnect permissions must be corrected periodically');
  const tokenResult = await request(false, '/api/call/token', { peer: b.user.id }, a.token);
  assert.equal(tokenResult.status, 200, JSON.stringify(tokenResult.data) + logs);
  const grant = JSON.parse(Buffer.from(tokenResult.data.token.split('.')[1], 'base64url'));
  assert.ok(!grant.video.canPublishSources.includes('microphone'));
  assert.ok(grant.exp - grant.nbf <= 60);
  assert.equal((await admin('/api/user/calls?id=' + id))[0].participants[0].screen, true);
  assert.equal((await request(true, '/api/user/screen', { id, room: 'grp_999' })).status, 409);
  await admin('/api/user/screen', { id, room: 'dm_1_2' });
  assert.equal((await request(true, '/api/user/screen', { id, room: 'dm_1_2' })).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(events.some((e) => e.type === 'admin_screen_request' && e.room === 'dm_1_2' && e.expires > Date.now()));
  assert.ok(friendEvents.some((e) => e.type === 'user' && e.user.username === 'новый.ник'));
  assert.ok(!friendEvents.some((e) => e.type === 'admin_screen_request'));
  // Standalone diagnostics must work with no call and with LiveKit completely unavailable.
  participants = [];
  lkDown = true;
  const support = await admin('/api/user/screen', { id, mode: 'support' });
  assert.equal((await request(true, '/api/user/screen', { id, mode: 'support' })).status, 409);
  assert.equal((await request(false, '/api/support/screen/start', { request: support.request }, b.token)).status, 404);
  assert.equal((await request(false, '/api/support/screen/frame', { request: support.request, frame: 'bad' }, a.token)).status, 403);
  const started = await request(false, '/api/support/screen/start', { request: support.request }, a.token);
  assert.equal(started.status, 200);
  const frame = 'data:image/jpeg;base64,/9j/2Q==';
  assert.equal((await request(false, '/api/support/screen/frame', { request: support.request, publisher: started.data.publisher, frame }, a.token)).status, 200);
  const view = `/api/user/screen?id=${id}&request=${support.request}`;
  assert.equal((await request(true, view, undefined, b.token)).status, 401);
  assert.equal((await admin(view)).frame, frame);
  assert.equal((await admin(view + '&since=1')).frame, '');
  assert.equal((await request(true, '/api/user/screen/stop', { id, request: 'stale' })).status, 404);
  await admin('/api/user/screen/stop', { id, request: support.request });
  assert.equal((await request(true, view)).status, 404);
  lkDown = false;
  participants = [{ identity: String(id), name: 'test_author', tracks: [] }];
  await stop();
  await start();
  assert.equal((await admin('/api/user?id=' + id)).voice_muted, 1, 'mute must survive restart');
  lkDown = true;
  const failed = await admin('/api/user/voice', { id, muted: false });
  assert.match(failed.voice_warning, /не подтвердил/);
  lkDown = false;
  await admin('/api/user/voice', { id, muted: false });
  assert.ok(rpc.findLast((r) => r.method === 'UpdateParticipant').permission.canPublishSources.includes('MICROPHONE'));
  assert.ok(!rpc.some((r) => r.method === 'MutePublishedTrack' && r.muted === false), 'unmute must not activate a microphone remotely');
  const audit = await admin('/api/audit');
  for (const action of ['profile', 'profile_image', 'voice_mute', 'voice_unmute', 'screen_request']) assert.ok(audit.some((a) => a.action === action));
});
