import { STATUS_CODES } from "node:http";
import { WebSocketServer } from "ws";

const canonicalId = (id) => typeof id === "string" &&
  /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;

const sameOrigin = (request, trustProxy) => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || !/^https?:\/\/[^/\\?#@]+$/i.test(origin) ||
      typeof host !== "string" || !/^[^/\\?#@]+$/.test(host)) return false;
  // Match Express trust-proxy=1 protocol semantics, but never authorize X-Forwarded-Host.
  let protocol = request.socket.encrypted ? "https" : "http";
  if (trustProxy(request.socket.remoteAddress, 0)) {
    protocol = (request.headers["x-forwarded-proto"] || protocol).split(",")[0].trim();
  }
  if (protocol !== "http" && protocol !== "https") return false;
  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
};

const rejectUpgrade = (socket, status) => {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
};

export const attachRealtime = (server, { sessionMiddleware, pool, schema, trustProxy }) => {
  const realtime = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  realtime.on("wsClientError", (_error, socket) => rejectUpgrade(socket, 400));
  server.on("upgrade", (request, socket, head) => {
    const onError = () => socket.destroy();
    const onTimeout = () => socket.destroy();
    const cleanup = () => {
      socket.off("error", onError).off("timeout", onTimeout).off("close", cleanup);
    };
    socket.on("error", onError).once("timeout", onTimeout).once("close", cleanup);
    socket.setTimeout(5000);
    const deny = (status) => rejectUpgrade(socket, status);
    const authorize = async () => {
      const match = /^\/api\/realtime\/diagrams\/([^/?]+)$/.exec(request.url);
      if (!match) return deny(404);
      if (!sameOrigin(request, trustProxy)) return deny(403);
      // Parse using the very same signed-cookie middleware/store as HTTP. No response
      // is ended through this shim, so rolling save/touch hooks never run for WS.
      await new Promise((resolve, reject) => {
        sessionMiddleware(request, {}, (error) => error ? reject(error) : resolve());
      });
      if (socket.destroyed) return;
      const actor = request.session?.user?.id;
      if (!canonicalId(actor)) return deny(401);
      const id = match[1];
      // Actor and room permissions share one read-only SQL snapshot; never select scenes.
      const access = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM ${schema}.diagrams AS diagrams
        JOIN ${schema}.users AS owner ON owner.id = diagrams.user_id AND owner.is_active
        WHERE diagrams.id = $2 AND (diagrams.user_id = actor.id OR EXISTS (
          SELECT 1 FROM ${schema}.diagram_members WHERE diagram_id = diagrams.id AND user_id = actor.id
        ))) AS allowed FROM ${schema}.users AS actor WHERE actor.id = $1 AND actor.is_active`,
      [actor, canonicalId(id) ? id : null]);
      if (socket.destroyed) return;
      if (!access.rowCount) return deny(401);
      if (!canonicalId(id)) return deny(400);
      if (!access.rows[0].allowed) return deny(404);
      realtime.handleUpgrade(request, socket, head, (client) => {
        cleanup();
        socket.setTimeout(0);
        client.on("error", () => client.terminate());
        // T4a has no inbound protocol, relay, scene write or session renewal.
        client.on("message", () => client.close(1008, "No data protocol yet"));
        client.send(JSON.stringify({ type: "ready", diagramId: id }));
      });
    };
    void authorize().catch(() => deny(500));
  });
};
