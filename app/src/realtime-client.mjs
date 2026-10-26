export const mayApplyScene = (frame, hasUnsavedChanges) => {
  if (hasUnsavedChanges || !frame || typeof frame !== "object" || Array.isArray(frame)) return false;
  // The relay forwards frames with `sender` added, so that key is the only allowed extra.
  const keys = Object.keys(frame);
  if (frame.type !== "scene" || !keys.includes("payload")) return false;
  if (!keys.every((key) => ["type", "payload", "sender"].includes(key))) return false;
  const payload = frame.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
    Object.keys(payload).length === 1 && Array.isArray(payload.elements);
};

export const closeDecision = (code, reconnects) =>
  [1008, 401, 403, 404].includes(code) ? "authorization_failed" :
    reconnects < 1 ? "reconnect" : "stop";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const envelope = (frame, type) => exact(frame, ["type", "payload", "sender"]) && frame.type === type &&
  exact(frame.sender, ["userId", "peerId"]) && [frame.sender.userId, frame.sender.peerId]
    .every((id) => typeof id === "string" && id.length > 0);
const validPointer = (payload) => exact(payload, ["button", "pointer"]) &&
  ["up", "down"].includes(payload.button) && exact(payload.pointer, ["x", "y", "tool"]) &&
  Number.isFinite(payload.pointer.x) && Number.isFinite(payload.pointer.y) &&
  ["pointer", "laser"].includes(payload.pointer.tool);
const mimeTypes = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp",
  "image/bmp", "image/x-icon", "image/avif", "image/jfif", "application/octet-stream"]);
const validFile = (id, file) => {
  if (!record(file) || !id || file.id !== id || !mimeTypes.has(file.mimeType) ||
    typeof file.dataURL !== "string" || !Number.isFinite(file.created) || file.created < 0 ||
    !Object.keys(file).every((key) => ["id", "mimeType", "dataURL", "created", "lastRetrieved", "version"].includes(key))) return false;
  if (Object.hasOwn(file, "lastRetrieved") && (!Number.isFinite(file.lastRetrieved) || file.lastRetrieved < 0)) return false;
  if (Object.hasOwn(file, "version") && (!Number.isSafeInteger(file.version) || file.version <= 0)) return false;
  const comma = file.dataURL.indexOf(",");
  const header = file.dataURL.slice(0, comma), mime = `data:${file.mimeType}`;
  return comma >= 0 && comma < file.dataURL.length - 1 && (header === mime || header.startsWith(`${mime};`));
};
export const mayApplyPointer = (frame) => envelope(frame, "pointer") && validPointer(frame.payload);
export const mayApplyFiles = (frame) => envelope(frame, "files") && exact(frame.payload, ["files"]) &&
  record(frame.payload.files) && Object.entries(frame.payload.files).every(([id, file]) => validFile(id, file));
export const pointerDelay = (lastSentAt, now) => lastSentAt === null ? 0 : Math.max(0, 50 - (now - lastSentAt));
export const freshPointers = (entries, now) => new Map([...entries].filter(([, value]) => now - value.seenAt < 5000));
export const filesToSend = (files, knownIds) => Object.fromEntries(Object.entries(files)
  .filter(([id, file]) => !knownIds.has(id) && validFile(id, file)));

// The caller supplies the mounted editor's window and only publishes persisted scenes.
export function openRealtime({ diagramId, ownerWindow, onScene, onAuthorizationFailure,
  getFiles = () => ({}), onFiles = () => {}, onCollaborators = () => {} }) {
  const url = new URL(`/api/realtime/diagrams/${encodeURIComponent(diagramId)}`, ownerWindow.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  let timer;
  let stopped = false;
  let reconnects = 0;
  let pendingScene = null;
  let pendingPointer = null;
  let pointerTimer;
  let expiryTimer;
  let lastSentAt = null;
  let pointers = new Map();
  const knownFiles = new Set();
  const now = () => ownerWindow.performance.now();
  const send = (type, payload) => {
    if (stopped || socket?.readyState !== 1) return false;
    socket.send(JSON.stringify({ type, payload }));
    return true;
  };
  const publishFiles = () => {
    const files = filesToSend(getFiles(), knownFiles);
    if (Object.keys(files).length && send("files", { files })) {
      Object.keys(files).forEach((id) => knownFiles.add(id));
    }
  };
  const flushPointer = () => {
    pointerTimer = undefined;
    if (!pendingPointer) return;
    if (send("pointer", pendingPointer)) lastSentAt = now();
    pendingPointer = null;
  };
  const updateCollaborators = () => {
    ownerWindow.clearTimeout(expiryTimer);
    pointers = freshPointers(pointers, now());
    onCollaborators(new Map([...pointers].map(([id, value]) => [id, value.cursor])));
    if (pointers.size) {
      const deadline = Math.min(...[...pointers.values()].map((value) => value.seenAt + 5000));
      expiryTimer = ownerWindow.setTimeout(updateCollaborators, Math.max(0, deadline - now()));
    }
  };
  const clearEphemeral = () => {
    ownerWindow.clearTimeout(pointerTimer);
    ownerWindow.clearTimeout(expiryTimer);
    pointerTimer = undefined;
    pendingPointer = null;
    pointers.clear();
    onCollaborators(new Map());
  };
  const flush = () => {
    if (!stopped && socket?.readyState === 1 && pendingScene) {
      socket.send(JSON.stringify({ type: "scene", payload: { elements: pendingScene } }));
      pendingScene = null;
    }
  };
  const connect = () => {
    if (stopped) return;
    socket = new ownerWindow.WebSocket(url.href);
    socket.onopen = () => {
      if (stopped) return;
      publishFiles();
      flush();
    };
    socket.onmessage = (event) => {
      if (stopped) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (mayApplyPointer(frame)) {
        pointers.set(frame.sender.peerId, { seenAt: now(), cursor: {
          pointer: frame.payload.pointer, button: frame.payload.button, userState: "active",
        } });
        updateCollaborators();
      } else if (mayApplyFiles(frame)) {
        Object.keys(frame.payload.files).forEach((id) => knownFiles.add(id));
        const local = getFiles();
        onFiles(Object.values(frame.payload.files).filter((file) => !Object.hasOwn(local, file.id)));
      } else onScene(frame);
    };
    socket.onclose = (event) => {
      if (stopped) return;
      clearEphemeral();
      const decision = closeDecision(event.code, reconnects);
      if (decision === "reconnect") {
        reconnects += 1;
        timer = ownerWindow.setTimeout(connect, 500);
      } else {
        stopped = true;
        pendingScene = null;
        if (decision === "authorization_failed") onAuthorizationFailure();
      }
    };
  };
  connect();
  return {
    diagramId,
    publishFiles,
    publishPointer(payload) {
      if (stopped || socket?.readyState !== 1 || !validPointer(payload)) return;
      pendingPointer = payload;
      if (pointerTimer !== undefined) return;
      const delay = pointerDelay(lastSentAt, now());
      if (delay === 0) flushPointer();
      else pointerTimer = ownerWindow.setTimeout(flushPointer, delay);
    },
    publishPersistedScene(id, elements) {
      if (stopped || id !== diagramId) return;
      pendingScene = elements;
      flush();
    },
    close() {
      stopped = true;
      pendingScene = null;
      clearEphemeral();
      ownerWindow.clearTimeout(timer);
      socket?.close();
    },
  };
}
