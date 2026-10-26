import test from "node:test";
import assert from "node:assert/strict";
import { mayApplyScene, closeDecision } from "./realtime-client.mjs";
import * as client from "./realtime-client.mjs";

const file = { id: "img", mimeType: "image/png", dataURL: "data:image/png;base64,YQ==", created: 0 };
const sender = { userId: "2", peerId: "peer" };
const pointerFrame = { type: "pointer", sender, payload: { button: "down", pointer: { x: 1, y: 2, tool: "pointer" } } };
const filesFrame = { type: "files", sender, payload: { files: { img: file } } };

test("pointer throttle has a 50ms boundary, including button release", () => {
  assert.equal(client.pointerDelay(null, 0), 0);
  assert.equal(client.pointerDelay(0, 0), 50);
  assert.equal(client.pointerDelay(0, 49), 1);
  assert.equal(client.pointerDelay(0, 50), 0);
  assert.equal(client.pointerDelay(0, 100), 0);
});

test("stale pointer certificates expire at 5000ms, independently per sender", () => {
  const entries = new Map([["old", { seenAt: 0 }], ["new", { seenAt: 1 }]]);
  assert.deepEqual([...client.freshPointers(entries, 4999).keys()], ["old", "new"]);
  assert.deepEqual([...client.freshPointers(entries, 5000).keys()], ["new"]);
  assert.equal(client.freshPointers(entries, 5001).size, 0);
});

test("only valid, unknown files need sending; selection is pure", () => {
  const known = new Set(["img"]);
  assert.deepEqual(client.filesToSend({ img: file }, known), {});
  assert.deepEqual(client.filesToSend({ img: file }, new Set()), { img: file });
  assert.deepEqual(client.filesToSend({ img: { ...file, mimeType: "text/plain" } }, new Set()), {});
  assert.deepEqual([...known], ["img"]);
});

test("pointer frame gate requires exact shapes, finite coordinates and allowed tools", () => {
  assert.equal(client.mayApplyPointer(pointerFrame), true);
  assert.equal(client.mayApplyPointer({ ...pointerFrame, payload: { button: "up", pointer: { x: 0, y: -2, tool: "laser" } } }), true);
  for (const frame of [null, [], {}, { ...pointerFrame, extra: 1 },
    { ...pointerFrame, sender: { userId: "2" } },
    { ...pointerFrame, payload: { ...pointerFrame.payload, extra: 1 } },
    ...[Infinity, NaN, "1"].map((x) => ({ ...pointerFrame, payload: { button: "up", pointer: { x, y: 0, tool: "pointer" } } })),
    ...[{ x: 1, y: 2 }, { x: 1, y: 2, tool: "pen" }, { x: 1, y: 2, tool: "pointer", z: 0 }].map((pointer) => ({ ...pointerFrame, payload: { button: "up", pointer } })),
    { ...pointerFrame, payload: { ...pointerFrame.payload, button: "left" } }]) {
    assert.equal(client.mayApplyPointer(frame), false);
  }
});

test("files gate validates allowlist, MIME boundaries, metadata and exact keys", () => {
  assert.equal(client.mayApplyFiles(filesFrame), true);
  for (const mimeType of ["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif", "image/jfif", "application/octet-stream"]) {
    assert.equal(client.mayApplyFiles({ ...filesFrame, payload: { files: { img: { ...file, mimeType, dataURL: `data:${mimeType},body\nbody`, lastRetrieved: 0, version: 1 } } } }), true);
  }
  for (const patch of [{ id: "other" }, { mimeType: "text/plain" }, { dataURL: "data:image/jpeg,x" },
    { dataURL: "data:image/pngish,x" }, { dataURL: "data:image/png," }, { dataURL: "data:image/png" },
    { created: -1 }, { created: Infinity }, { lastRetrieved: -1 }, { version: 0 }, { version: 1.5 }, { extra: 1 }]) {
    assert.equal(client.mayApplyFiles({ ...filesFrame, payload: { files: { img: { ...file, ...patch } } } }), false);
  }
  for (const frame of [null, [], {}, { ...filesFrame, extra: 0 }, { ...filesFrame, sender: null },
    { ...filesFrame, payload: { files: {}, extra: 0 } }, { ...filesFrame, payload: { files: [] } },
    { ...filesFrame, payload: { files: { "": { ...file, id: "" } } } }]) {
    assert.equal(client.mayApplyFiles(frame), false);
  }
});

function harness() {
  let time = 0;
  let next = 0;
  const timers = new Map(), sockets = [], sent = [], cursors = [];
  let files = { img: file };
  class Socket {
    readyState = 0;
    constructor() { sockets.push(this); }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const ownerWindow = {
    location: { href: "https://example.test/" }, WebSocket: Socket,
    performance: { now: () => time },
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  let failures = 0;
  const connection = client.openRealtime({ diagramId: "1", ownerWindow,
    getFiles: () => files, onFiles: (incoming) => { files = { ...files, ...Object.fromEntries(incoming.map((entry) => [entry.id, entry])) }; },
    onCollaborators: (value) => cursors.push(value), onScene: () => {},
    onAuthorizationFailure: () => { failures += 1; },
  });
  const advance = (ms) => {
    const end = time + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    time = end;
  };
  const open = () => { const socket = sockets.at(-1); socket.readyState = 1; socket.onopen(); return socket; };
  return { connection, sockets, sent, cursors, advance, open, files: () => files, failures: () => failures };
}

test("transport coalesces movement and final up within 50ms; close cancels timers", () => {
  const h = harness();
  h.open();
  h.connection.publishPointer(pointerFrame.payload);
  for (let x = 0; x < 100; x += 1) h.connection.publishPointer({ button: "down", pointer: { x, y: 0, tool: "pointer" } });
  h.connection.publishPointer({ ...pointerFrame.payload, button: "up" });
  h.advance(49);
  assert.equal(h.sent.filter((frame) => frame.type === "pointer").length, 1);
  h.advance(1);
  const frames = h.sent.filter((frame) => frame.type === "pointer");
  assert.equal(frames.length, 2);
  assert.equal(frames[1].payload.button, "up");
  assert.deepEqual(Object.keys(frames[1]), ["type", "payload"]);
  h.connection.publishPointer(pointerFrame.payload);
  h.connection.close();
  h.advance(5000);
  assert.equal(h.sent.filter((frame) => frame.type === "pointer").length, 2);
});

test("transport files deduplicate, preserve local ids, and cursors expire without polling", () => {
  const h = harness(), socket = h.open();
  h.connection.publishFiles();
  assert.equal(h.sent.filter((frame) => frame.type === "files").length, 1);
  socket.onmessage({ data: JSON.stringify({ ...filesFrame, payload: { files: {
    img: { ...file, dataURL: "data:image/png,remote" }, other: { ...file, id: "other" },
  } } }) });
  assert.equal(h.files().img.dataURL, file.dataURL);
  assert.equal(h.files().other.id, "other");
  h.connection.publishFiles();
  assert.equal(h.sent.filter((frame) => frame.type === "files").length, 1);
  socket.onmessage({ data: JSON.stringify(pointerFrame) });
  h.advance(4999);
  assert.equal(h.cursors.at(-1).size, 1);
  h.advance(1);
  assert.equal(h.cursors.at(-1).size, 0);
  const updates = h.cursors.length;
  h.advance(10000);
  assert.equal(h.cursors.length, updates);
  h.connection.close();
});

test("transport retains one reconnect and permanently stops after authorization failure", () => {
  const h = harness(), socket = h.open();
  socket.onmessage({ data: JSON.stringify(pointerFrame) });
  socket.readyState = 3;
  socket.onclose({ code: 1006 });
  assert.equal(h.cursors.at(-1).size, 0);
  h.advance(500);
  const retry = h.open();
  retry.readyState = 3;
  retry.onclose({ code: 1008 });
  h.connection.publishFiles();
  h.connection.publishPointer(pointerFrame.payload);
  h.advance(10000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.failures(), 1);
});

const scene = { type: "scene", payload: { elements: [] } };

test("scene applies only when there are no unsaved local changes", async () => {
  const { mayApplyScene: decide } = await import("./realtime-client.mjs");
  assert.equal(decide(scene, false), true);
  assert.equal(decide(scene, true), false);
});

test("non-scene and malformed frames never apply", () => {
  for (const frame of [null, {}, { type: "pointer", payload: {} },
    { type: "scene" }, { type: "scene", payload: { elements: {} } },
    { type: "scene", payload: { elements: [] }, unexpected: {} }]) {
    assert.equal(mayApplyScene(frame, false), false);
  }
  assert.equal(mayApplyScene({ ...scene, sender: { userId: "2" } }, false), true);
});

test("authorization failures stop permanently even before the retry", () => {
  for (const code of [1008, 401, 403, 404]) {
    for (const reconnects of [0, 1]) {
      assert.equal(closeDecision(code, reconnects), "authorization_failed");
    }
  }
});

test("other closes allow exactly one reconnect without resetting on success", () => {
  for (const code of [1000, 1006, 1011, 1013]) {
    assert.equal(closeDecision(code, 0), "reconnect");
    assert.equal(closeDecision(code, 1), "stop");
    assert.equal(closeDecision(code, 2), "stop");
  }
});
