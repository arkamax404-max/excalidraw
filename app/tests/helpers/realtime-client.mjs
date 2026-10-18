import WebSocket from "ws";

export const realtimeOrigin = "http://127.0.0.1:3035";

// Return transport failures as evidence, not unhandled events or hung tests.
export const realtimeResult = (id, { cookie, origin = realtimeOrigin, headers = {} } = {}) => new Promise((resolve) => {
  const socket = new WebSocket(`${realtimeOrigin.replace("http:", "ws:")}/api/realtime/diagrams/${id}`, {
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(origin === null ? {} : { Origin: origin }) },
    perMessageDeflate: false,
    handshakeTimeout: 2000,
  });
  let settled = false;
  let status;
  let response;
  let body = "";
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (response) {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onResponseError);
      response.destroy();
    }
    // Keep the error listener until close: terminate during CONNECTING emits error.
    socket.terminate();
    resolve(result);
  };
  const onData = (chunk) => { body = (body + chunk.toString()).slice(0, 4096); };
  const onEnd = () => finish({ status, body });
  const onResponseError = (error) => finish({ status, body, code: error.code ?? error.message });
  const onOpen = () => { status = 101; };
  const onMessage = (data, binary) => finish({ status, body: data.toString(), binary });
  const onError = (error) => finish({ status, body, code: error.code ?? error.message });
  const onUnexpected = (_request, incoming) => {
    response = incoming;
    status = incoming.statusCode;
    incoming.on("data", onData).once("end", onEnd).once("error", onResponseError);
  };
  const onClose = (code) => {
    finish({ status, body, code });
    socket.off("open", onOpen).off("message", onMessage).off("error", onError)
      .off("unexpected-response", onUnexpected).off("close", onClose);
  };
  const timer = setTimeout(() => finish({ status, body, code: "REALTIME_TIMEOUT" }), 3000);
  socket.once("open", onOpen).on("message", onMessage).on("error", onError)
    .once("unexpected-response", onUnexpected).once("close", onClose);
});
