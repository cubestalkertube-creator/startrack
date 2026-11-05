// Short-lived presence, aggregated across a user's windows/devices.
export function createTyping(emit, ttl = 6000) {
  const entries = new Map();
  const keyOf = (ws, target) => `${ws.uid}/${target.key}`;
  function remove(ws, target) {
    const key = keyOf(ws, target), entry = entries.get(key);
    if (!entry) return;
    clearTimeout(entry.connections.get(ws));
    entry.connections.delete(ws);
    if (!entry.connections.size) {
      entries.delete(key);
      emit(ws.uid, entry.target, false);
    }
  }
  function set(ws, target, active) {
    if (!active) return remove(ws, target);
    const key = keyOf(ws, target);
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { target, connections: new Map(), sent: 0 });
    clearTimeout(entry.connections.get(ws));
    const timer = setTimeout(() => remove(ws, target), ttl);
    timer.unref();
    entry.connections.set(ws, timer);
    if (Date.now() - entry.sent >= 2000) {
      entry.sent = Date.now();
      emit(ws.uid, target, true);
    }
  }
  function leave(ws) {
    for (const entry of entries.values()) if (entry.connections.has(ws)) remove(ws, entry.target);
  }
  function stop(uid, target) {
    const entry = entries.get(`${uid}/${target.key}`);
    if (entry) for (const ws of [...entry.connections.keys()]) remove(ws, target);
  }
  return { set, leave, stop };
}
