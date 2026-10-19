// Fixture-only preload. Marker contract: final authorization query is tagged
// /* realtime:enqueue */; its result resolves with session/user/room/member SHARE
// locks held. Production must recheck expiry and enqueue synchronously afterward.
// Lock order: SID, numeric users, diagram, actual memberships; no later advisories.
// Both sender and recipient stored identity/expiry must still match at enqueue.
import pg from "pg";
import WebSocket from "ws";
import { Server } from "node:http";

// Observe real realtime-owned timers, not unref status or active-handle visibility.
const timers = new Map(), upgrades = [], closeEvents = [];
let httpServer, finishClose;
const httpClosed = new Promise((resolve) => { finishClose = resolve; });
const timerCounts = { interval: 0, timeout: 0 };
for (const [kind, setName, clearName] of [["interval", "setInterval", "clearInterval"], ["timeout", "setTimeout", "clearTimeout"]]) {
  const schedule = globalThis[setName], clear = globalThis[clearName];
  globalThis[setName] = function (callback, delay, ...args) {
    if (!/\/realtime\.mjs:/.test(new Error().stack?.split("\n")[2] ?? "")) return schedule(callback, delay, ...args);
    let timer;
    const run = function (...values) {
      if (kind === "timeout") timers.delete(timer);
      return callback.apply(this, values);
    };
    timer = schedule(run, delay, ...args);
    timers.set(timer, kind); timerCounts[kind]++;
    return timer;
  };
  globalThis[clearName] = function (timer) { timers.delete(timer); return clear(timer); };
}
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  httpServer = this;
  this.prependListener("upgrade", (_request, socket) => {
    const kinds = ["error", "timeout", "close"];
    const before = kinds.map((kind) => socket.listeners(kind));
    const record = { socket, listeners: [] }; upgrades.push(record);
    queueMicrotask(() => { record.listeners = kinds.flatMap((kind, i) =>
      socket.listeners(kind).filter((listener) => !before[i].includes(listener)).map((listener) => [kind, listener])); });
  });
  return listen.apply(this, args);
};
const shutdownState = () => ({ listening: httpServer.listening, closeEvents: [...closeEvents],
  timers: [...timers.values()], timerCounts: { ...timerCounts },
  upgrades: upgrades.map(({ socket, listeners }) => ({ destroyed: socket.destroyed,
    listeners: listeners.filter(([kind, listener]) => socket.listeners(kind).includes(listener)).length })) });
process.on("message", async (event) => {
  if (!event.shutdown) return;
  if (event.shutdown === "close") {
    httpServer.once("close", () => { closeEvents.push("close"); finishClose(); });
    const returned = httpServer.close((error) => { closeEvents.push(error?.code ?? "callback"); });
    process.send({ shutdown: event.token, returnedServer: returned === httpServer, ...shutdownState() });
  } else {
    if (event.shutdown === "closed") await httpClosed;
    process.send({ shutdown: event.token, ...shutdownState() });
  }
});

let armed = false;
let release;
let pressure = false;
// Child-only wall clock: PgStore and the frame gate both use Date.now/ceil.
// Database NOW() and real transport/deadline timers deliberately remain untouched.
const wallNow = Date.now;
let clock;
Date.now = () => clock ?? wallNow();
const sessionWrites = [];
const buffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount");
Object.defineProperty(WebSocket.prototype, "bufferedAmount", { ...buffered, get() {
  return pressure && this._isServer ? 25 * 1024 * 1024 : buffered.get.call(this);
} });
process.on("message", (event) => {
  if (event.realtime === "observe") {
    clock = event.now ?? undefined;
    process.send({ realtime: "observed", now: Date.now(), writes: [...sessionWrites] });
  } else if (event.realtime === "arm") {
    armed = true;
    process.send({ realtime: "armed" });
  } else if (event.realtime === "release") {
    pressure = Boolean(event.pressure);
    release?.();
  }
});
const query = pg.Client.prototype.query;
pg.Client.prototype.query = async function (...args) {
  const sql = String(args[0]?.text ?? args[0]);
  const result = await query.apply(this, args);
  if (/^\s*(INSERT INTO|UPDATE)\b/i.test(sql) && sql.includes('"user_sessions"')) {
    sessionWrites.push(sql.trim().split(/\s+/)[0].toUpperCase());
  }
  if (armed && sql.includes("/* realtime:enqueue */")) {
    armed = false;
    await new Promise((resolve) => { release = resolve; process.send({ realtime: "blocked" }); });
    release = undefined;
  }
  return result;
};

// A-only injected promise stalls BEFORE SQL/acquisition, not PG locks or pool exhaustion.
let fault, unblock, tracked, faultArmed = false;
let consumed = 0, matches = 0, pending = 0, earlyRelease = 0, expectedError;
const state = () => ({ consumed, matches, pending, earlyRelease, expectedError: expectedError && expectedError.stack + "\n",
  began: tracked?.began, queryDone: tracked?.queryDone, rollbackDone: tracked?.rollbackDone });
const observed = () => process.send({ fault: fault.control, phase: "observed" });
process.on("message", (event) => {
  if (event.control === undefined) return;
  if (event.action === "arm") {
    fault = event; faultArmed = true; tracked = undefined; consumed = matches = pending = earlyRelease = 0; expectedError = undefined;
  } else if (event.action === "release") { faultArmed = false; unblock?.(); }
  process.send({ control: event.control, ...state() });
});
const hold = () => new Promise((resolve) => { pending++; unblock = () => { pending--; unblock = undefined; resolve(); }; });
const track = (client, began = false) => {
  const record = { client, began, active: 0, queryDone: false, rollbackDone: false, token: fault.control };
  tracked = record;
  const releaseClient = client.release;
  client.release = (...args) => {
    if (record.active || (record.began && (!record.queryDone || !record.rollbackDone))) earlyRelease++;
    client.release = releaseClient;
    process.send({ fault: record.token, phase: "settled", ...state() });
    return releaseClient(...args);
  };
};
const faultQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const sql = String(args[0]?.text ?? args[0]), values = args[0]?.values ?? args[1];
  const audit = fault && ["audit-error", "query-stall", "pool-stall"].includes(fault.mode) &&
    /SELECT sid, sess, EXTRACT/.test(sql) && values?.[0]?.includes(fault.sid);
  const mutation = fault && ((fault.mode === "logout-error" && /^DELETE FROM .*user_sessions/.test(sql) && values?.[0] === fault.sid) ||
    (fault.mode === "deactivate-error" && /UPDATE .*users\s+SET/s.test(sql) && String(values?.[0]) === fault.actor));
  const upgrade = fault?.mode === "upgrade-stall" && /SELECT EXISTS/.test(sql) && String(values?.[0]) === fault.actor;
  if (audit || upgrade) matches++;
  const selected = faultArmed && (audit || mutation || upgrade) && !consumed;
  if (selected) { consumed++; if (fault.mode === "query-stall" || upgrade) track(this, !upgrade); }
  const record = tracked?.client === this ? tracked : null;
  if (!selected && !record) return faultQuery.apply(this, args);
  const callback = typeof args.at(-1) === "function" ? args.pop() : args[0]?.callback;
  if (args[0]?.callback) args[0] = { ...args[0], callback: undefined };
  const run = async () => {
    if (record) { record.active++; if (/^BEGIN\b/.test(sql)) record.began = true; }
    try {
      if (selected) {
        const stalled = ["query-stall", "upgrade-stall"].includes(fault.mode) ? hold() : null;
        observed();
        if (stalled) await stalled;
        else { const error = new Error(`isolated realtime ${fault.mode}`); expectedError = error; throw error; }
      }
      const result = await faultQuery.apply(this, args);
      if (record && /SELECT sid, sess, EXTRACT|SELECT EXISTS/.test(sql)) record.queryDone = true;
      if (record && /^ROLLBACK\b/.test(sql)) record.rollbackDone = true;
      return result;
    } finally { if (record) record.active--; }
  };
  if (callback) { void run().then((result) => callback(null, result), callback); return; }
  return run();
};
const connect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (...args) {
  if (!faultArmed || fault?.mode !== "pool-stall" || consumed) return connect.apply(this, args);
  consumed++;
  const stalled = hold(); observed();
  const acquire = async () => { await stalled; const client = await connect.call(this); track(client); return client; };
  const callback = args[0];
  if (typeof callback === "function") { void acquire().then((client) => callback(null, client, client.release), callback); return; }
  return acquire();
};
