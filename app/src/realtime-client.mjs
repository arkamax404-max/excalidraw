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

// The caller supplies the mounted editor's window and only publishes persisted scenes.
export function openRealtime({ diagramId, ownerWindow, onScene, onAuthorizationFailure }) {
  const url = new URL(`/api/realtime/diagrams/${encodeURIComponent(diagramId)}`, ownerWindow.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  let timer;
  let stopped = false;
  let reconnects = 0;
  let pendingScene = null;
  const flush = () => {
    if (!stopped && socket?.readyState === 1 && pendingScene) {
      socket.send(JSON.stringify({ type: "scene", payload: { elements: pendingScene } }));
      pendingScene = null;
    }
  };
  const connect = () => {
    if (stopped) return;
    socket = new ownerWindow.WebSocket(url.href);
    socket.onopen = flush;
    socket.onmessage = (event) => {
      if (stopped) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      onScene(frame);
    };
    socket.onclose = (event) => {
      if (stopped) return;
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
    publishPersistedScene(id, elements) {
      if (stopped || id !== diagramId) return;
      pendingScene = elements;
      flush();
    },
    close() {
      stopped = true;
      pendingScene = null;
      ownerWindow.clearTimeout(timer);
      socket?.close();
    },
  };
}
