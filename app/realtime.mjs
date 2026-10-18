import { STATUS_CODES } from "node:http";
import { randomUUID } from "node:crypto";
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

export const attachRealtime = (server, { sessionMiddleware, pool, schema, sessionTable, trustProxy }) => {
  const limit = 25 * 1024 * 1024;
  const realtime = new WebSocketServer({ noServer: true, maxPayload: limit, perMessageDeflate: false });
  const peers = new Set();
  const live = (peer) => peer.socket.readyState === 1;
  const close = (peer, code = 1008, reason = "Access denied") => {
    peer.queue.length = 0; peer.bytes = 0;
    if (live(peer)) peer.socket.close(code, reason);
  };
  const deliver = async (sender, recipient, frame) => {
    if (!live(sender)) return;
    let connection;
    try {
      connection = await pool.connect();
      await connection.query("BEGIN");
      const owner = (await connection.query(`SELECT user_id FROM ${schema}.diagrams WHERE id=$1`, [sender.id])).rows[0]?.user_id;
      // Same PgStore table, no get/touch/save: lock SIDs, numeric users, room, memberships.
      const sessions = (await connection.query(`SELECT sid, sess, EXTRACT(EPOCH FROM expire::timestamptz) AS expires
        FROM ${schema}.${sessionTable} WHERE sid=ANY($1::text[]) ORDER BY sid FOR SHARE`,
      [[sender.sid, recipient?.sid].filter(Boolean)])).rows;
      const actors = [...new Set([sender.actor, recipient?.actor, owner].filter(Boolean))];
      const users = (await connection.query(`SELECT id, is_active FROM ${schema}.users
        WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE`, [actors])).rows;
      const room = (await connection.query(`SELECT user_id FROM ${schema}.diagrams WHERE id=$1 FOR SHARE`, [sender.id])).rows[0];
      const members = (await connection.query(`SELECT ${recipient ? "/* realtime:enqueue */" : ""} user_id
        FROM ${schema}.diagram_members WHERE diagram_id=$1 AND user_id=ANY($2::bigint[]) ORDER BY user_id FOR SHARE`,
      [sender.id, [sender.actor, recipient?.actor].filter(Boolean)])).rows;
      // Everything below, including enqueue, is synchronous while all rows remain locked.
      const now = Math.ceil(Date.now() / 1000);
      const active = (id) => users.some((user) => user.id === id && user.is_active);
      const valid = (peer) => sessions.some((row) => row.sid === peer.sid &&
        row.sess?.user?.id === peer.actor && Number(row.expires) >= now) && active(peer.actor) &&
        (peer.actor === owner || members.some((member) => member.user_id === peer.actor));
      if (!room || room.user_id !== owner || !active(owner)) {
        for (const peer of peers) if (peer.id === sender.id) close(peer);
        return;
      }
      if (!valid(sender)) return close(sender);
      if (recipient && !valid(recipient)) return close(recipient);
      if (!live(sender) || !recipient || !live(recipient)) return;
      if (Buffer.byteLength(frame) > limit) return close(sender, 1009, "Message too large");
      if (recipient.socket.bufferedAmount + Buffer.byteLength(frame) > limit) return close(recipient, 1013, "Backpressure");
      recipient.socket.send(frame);
    } catch {
      close(sender);
      if (recipient) close(recipient);
    } finally {
      if (connection) {
        try { await connection.query("ROLLBACK"); connection.release(); }
        catch (error) {
          connection.release(error); close(sender);
          if (recipient) close(recipient);
        }
      }
    }
  };
  const drain = async (peer) => {
    peer.busy = true;
    try {
      while (peer.queue.length && live(peer)) {
        const { data, binary } = peer.queue.shift(); peer.bytes -= data.length;
        let value;
        try { value = JSON.parse(data.toString("utf8")); } catch { /* Reject through the same policy below. */ }
        if (binary || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
            value.type !== "sync_request" || !value.payload || typeof value.payload !== "object" ||
            Array.isArray(value.payload) || Object.keys(value.payload).length) return close(peer, 1008, "No data protocol yet");
        const frame = JSON.stringify({ type: "sync_request", sender: { userId: peer.actor, peerId: peer.peerId }, payload: {} });
        const recipients = [...peers].filter((other) => other !== peer && other.id === peer.id && live(other));
        if (!recipients.length) await deliver(peer);
        for (const recipient of recipients) {
          if (!live(peer)) break;
          await deliver(peer, recipient, frame);
        }
      }
    } catch { close(peer); }
    finally { peer.busy = false; if (!live(peer)) { peer.queue.length = 0; peer.bytes = 0; } }
  };
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
        // Preserve ws protocol close codes (notably 1009) instead of destroying their close frame.
        client.on("error", () => { if (client.readyState === 1) client.close(1008, "Transport error"); });
        const peer = { socket: client, actor, sid: request.sessionID, id, peerId: randomUUID(), queue: [], bytes: 0, busy: false };
        peers.add(peer);
        client.once("close", () => { peers.delete(peer); peer.queue.length = 0; peer.bytes = 0; });
        client.on("message", (data, binary) => {
          if (!live(peer)) return;
          if (peer.queue.length >= 8 || peer.bytes + data.length > limit) return close(peer, 1013, "Queue overloaded");
          peer.queue.push({ data, binary }); peer.bytes += data.length;
          if (!peer.busy) void drain(peer);
        });
        client.send(JSON.stringify({ type: "ready", diagramId: id }));
      });
    };
    void authorize().catch(() => deny(500));
  });
};
