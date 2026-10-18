// Fixture-only preload. Marker contract: final authorization query is tagged
// /* realtime:enqueue */; its result resolves with session/user/room/member SHARE
// locks held. Production must recheck expiry and enqueue synchronously afterward.
// Lock order: SID, numeric users, diagram, actual memberships; no later advisories.
// Both sender and recipient stored identity/expiry must still match at enqueue.
import pg from "pg";
import WebSocket from "ws";

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
