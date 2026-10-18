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
const buffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount");
Object.defineProperty(WebSocket.prototype, "bufferedAmount", { ...buffered, get() {
  return pressure && this._isServer ? 25 * 1024 * 1024 : buffered.get.call(this);
} });
process.on("message", (event) => {
  if (event.realtime === "arm") {
    armed = true;
    process.send({ realtime: "armed" });
  } else if (event.realtime === "release") {
    pressure = Boolean(event.pressure);
    release?.();
  }
});
const query = pg.Client.prototype.query;
pg.Client.prototype.query = async function (...args) {
  const result = await query.apply(this, args);
  if (armed && String(args[0]?.text ?? args[0]).includes("/* realtime:enqueue */")) {
    armed = false;
    await new Promise((resolve) => { release = resolve; process.send({ realtime: "blocked" }); });
    release = undefined;
  }
  return result;
};
