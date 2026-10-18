import WebSocket from "ws";
import { realtimeOrigin } from "./realtime-client.mjs";

// One bounded event queue, including terminal events; no background promise chain.
export const realtimePeer = (id, cookie, { compression = false, maxFrameBytes = 65536 } = {}) => {
  const socket = new WebSocket(`${realtimeOrigin.replace("http:", "ws:")}/api/realtime/diagrams/${id}`, {
    headers: { Cookie: cookie, Origin: realtimeOrigin },
    perMessageDeflate: compression, handshakeTimeout: 2000,
  });
  const queue = [];
  let waiting;
  let ended = false;
  let disposed = false;
  let finishClose;
  const push = (event) => {
    if (disposed) return;
    if (queue.length >= 8 || (event.data?.length ?? 0) > maxFrameBytes) {
      queue.length = 0;
      event = { type: "error", error: new Error("Realtime peer queue limit") };
      socket.terminate();
    }
    if (waiting) waiting(event);
    else queue.push(event);
  };
  const onMessage = (data, binary) => push({ type: "message", data: Buffer.from(data), binary });
  const onError = (error) => push({ type: "error", error });
  const onClose = (code, reason) => {
    ended = true;
    push({ type: "close", code, reason: reason.toString("utf8") });
    socket.off("message", onMessage).off("error", onError).off("close", onClose);
    finishClose?.();
  };
  socket.on("message", onMessage).on("error", onError).once("close", onClose);
  const next = (consume = true) => {
    if (queue.length) return Promise.resolve(consume ? queue.shift() : queue[0]);
    if (ended || disposed) return Promise.reject(new Error("Realtime peer is closed"));
    if (waiting) return Promise.reject(new Error("Concurrent realtime reads are unsupported"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = undefined;
        reject(new Error("Realtime event deadline exceeded"));
      }, 3000);
      waiting = (event) => {
        clearTimeout(timer); waiting = undefined;
        if (!consume && event.type !== "cancelled") queue.unshift(event);
        resolve(event);
      };
    });
  };
  const dispose = async () => {
    disposed = true;
    queue.length = 0;
    waiting?.({ type: "error", error: new Error("Realtime peer disposed") });
    if (ended) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finishClose = undefined;
        reject(new Error("Realtime teardown deadline exceeded"));
      }, 3000);
      finishClose = () => { clearTimeout(timer); finishClose = undefined; resolve(); };
      socket.terminate();
    });
  };
  return { next, dispose, cancelRead: () => waiting?.({ type: "cancelled" }),
    get open() { return socket.readyState === WebSocket.OPEN; },
    get extensions() { return socket.extensions; }, send: (value, options) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Realtime peer is not open");
    socket.send(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), options);
  } };
};
