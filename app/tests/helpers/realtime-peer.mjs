import WebSocket from "ws";
import { connect } from "node:net";
import { realtimeOrigin } from "./realtime-client.mjs";

// A genuine HTTP Upgrade sent over TCP; only a remote end counts as retirement.
export const pendingRealtimeUpgrade = (id, cookie) => {
  const url = new URL(realtimeOrigin), chunks = [], errors = [];
  let remoteEnd, resolveEnd;
  const ended = new Promise((resolve) => { resolveEnd = resolve; });
  const socket = connect(Number(url.port), url.hostname, () => socket.write(
    `GET /api/realtime/diagrams/${id} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${realtimeOrigin}\r\n` +
    `Cookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
  socket.on("data", (chunk) => { chunks.push(chunk); if (Buffer.concat(chunks).length > 65536) socket.destroy(new Error("Upgrade capture overflow")); });
  socket.on("error", (error) => errors.push(error.message));
  socket.once("end", () => { remoteEnd = performance.now(); resolveEnd(); });
  return { dispose: () => socket.destroy(), state: () => ({ remoteEnd, response: Buffer.concat(chunks).toString("utf8"), errors }),
    waitEnd: async () => {
      let timer;
      try { await Promise.race([ended, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Realtime shutdown pending upgrade transport did not end")), 1700);
      })]); } finally { clearTimeout(timer); }
    } };
};

// One bounded event queue, including terminal events; no background promise chain.
export const realtimePeer = (id, cookie, { compression = false, maxFrameBytes = 65536, deadlineMs = 3000, acknowledgeClose = true, deadlineMessage } = {}) => {
  const socket = new WebSocket(`${realtimeOrigin.replace("http:", "ws:")}/api/realtime/diagrams/${id}`, {
    headers: { Cookie: cookie, Origin: realtimeOrigin },
    perMessageDeflate: compression, handshakeTimeout: 2000,
  });
  let closeFrame;
  let transportEnd;
  if (!acknowledgeClose) socket.once("open", () => {
    // ws normally calls close() from its receiver's conclude handler to ACK.
    socket.close = () => {};
    socket._receiver.once("conclude", (code, reason) => {
      closeFrame = { code, reason: reason.toString("utf8"), at: performance.now() };
    });
    socket._socket.once("end", () => { transportEnd = performance.now(); });
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
        reject(new Error(deadlineMessage ?? (deadlineMs === 3000 ? "Realtime event deadline exceeded" : "Realtime idle close missing within safety deadline")));
      }, deadlineMs);
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
  return { next, dispose, get retirement() { return { closeFrame, transportEnd }; }, cancelRead: () => waiting?.({ type: "cancelled" }),
    get open() { return socket.readyState === WebSocket.OPEN; },
    get extensions() { return socket.extensions; }, send: (value, options) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Realtime peer is not open");
    socket.send(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), options);
  } };
};
