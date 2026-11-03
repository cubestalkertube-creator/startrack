// Presence belongs to a connection, so closing an old tab cannot remove a rejoined caller.
export function createDirectCalls(push) {
  const rooms = new Map();
  const sessions = new Map();
  const key = (a, b) => [a, b].sort((x, y) => x - y).join(':');
  const users = (a, b) => [...new Set([...(rooms.get(key(a, b)) || [])].map((ws) => ws.uid))];
  function broadcast(a, b) {
    const ids = users(a, b);
    push(a, { type: 'dcall', peer: b, users: ids });
    push(b, { type: 'dcall', peer: a, users: ids });
  }
  function leave(ws) {
    const peer = sessions.get(ws);
    if (!peer) return;
    sessions.delete(ws);
    const k = key(ws.uid, peer), room = rooms.get(k);
    room?.delete(ws);
    if (!room?.size) rooms.delete(k);
    broadcast(ws.uid, peer);
  }
  function join(ws, peer) {
    if (sessions.get(ws) === peer) return;
    leave(ws);
    const k = key(ws.uid, peer);
    if (!rooms.has(k)) rooms.set(k, new Set());
    rooms.get(k).add(ws);
    sessions.set(ws, peer);
    broadcast(ws.uid, peer);
  }
  function snapshot(uid) {
    const peers = new Set();
    for (const [ws, peer] of sessions) {
      if (ws.uid === uid) peers.add(peer);
      else if (peer === uid) peers.add(ws.uid);
    }
    return [...peers].map((peer) => ({ peer, users: users(uid, peer) }));
  }
  return { join, leave, users, snapshot };
}
