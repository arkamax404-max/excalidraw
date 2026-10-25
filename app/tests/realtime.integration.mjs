import assert from "node:assert/strict";
import test from "node:test";
import { persistenceFixture } from "./helpers/persistence-fixture.mjs";
import { realtimeOrigin, realtimeResult } from "./helpers/realtime-client.mjs";
import { realtimePeer } from "./helpers/realtime-peer.mjs";

const sync = { type: "sync_request", payload: {} };
const limit = 25 * 1024 * 1024;
const identities = new WeakMap();
const relay = async (sender, recipient, userId, value = sync, expected = sync) => {
  try {
    const received = Promise.race([sender.next(false).then((event) => ({ ...event, echo: true })), recipient.next()]);
    if (typeof value === "function") value(); else sender.send(value);
    const event = await received;
    assert.equal(event.type, "message", `expected relay, got ${JSON.stringify({ ...event, data: event.data?.length })}`);
    assert.equal(event.echo, undefined, "no sender echo");
    assert.equal(event.binary, false);
    const frame = JSON.parse(event.data.toString("utf8"));
    assert.equal(typeof frame.sender?.peerId, "string");
    assert.ok(frame.sender.peerId.length > 0);
    const peerId = identities.get(sender) ?? frame.sender.peerId;
    assert.deepEqual(frame, { ...expected, sender: { userId: String(userId), peerId } });
    identities.set(sender, peerId);
  } finally { sender.cancelRead(); recipient.cancelRead(); }
};
const closed = async (peer, code, reason) => {
  const event = await peer.next();
  assert.equal(event.type, "close", "no application frame before close");
  assert.equal(event.code, code);
  if (reason) assert.equal(event.reason, reason);
};
const syncFixture = async (t, body, peerOptions = {}) => {
  const f = await persistenceFixture(t, { realtime: true });
  for (const user of ["owner", "stranger"]) assert.equal((await f.request("/api/files/shared", user, "PUT", scene)).status, 200);
  const id = (await f.request("/api/diagrams", "owner")).body.diagrams[0].id;
  const other = (await f.request("/api/diagrams", "stranger")).body.diagrams[0].id;
  const route = `/api/diagrams/${id}`;
  assert.equal((await f.request(`${route}/members`, "owner", "POST", { username: "member" })).status, 201);
  const snapshot = async () => ({ documents: await f.snapshot(id, "shared"),
    control: await f.request(`/api/diagrams/${other}`, "stranger"),
    accounts: await f.request("/api/admin/users", "admin"), members: await f.request(`${route}/members`, "owner") });
  let expected = await snapshot();
  const peers = [];
  const open = async (user, room = id) => {
    const peer = realtimePeer(room, f.cookieFor(user), { compression: true, ...peerOptions });
    peers.push(peer);
    const ready = await peer.next();
    assert.equal(ready.type, "message"); assert.equal(ready.binary, false);
    assert.deepEqual(ready.data, Buffer.from(JSON.stringify({ type: "ready", diagramId: room })));
    assert.equal(peer.extensions, "", "compression must not be negotiated");
    return peer;
  };
  try {
    const a = await open("owner"), b = await open("member");
    const c = await open("stranger", other), d = await open("stranger", other);
    // Mandatory fast old-server boundary BEFORE arming a not-yet-existing SQL marker.
    await relay(a, b, f.users.owner); await relay(b, a, f.users.member);
    await body({ f, a, b, c, d, route, open, checkpoint: async () => { expected = await snapshot(); } });
  } finally {
    try { await Promise.all(peers.map((peer) => peer.dispose())); }
    finally { assert.deepEqual(await snapshot(), expected); }
  }
};

const scene = { elements: [{ id: "retained", isDeleted: true }],
  files: { image: { id: "image", dataURL: "data:image/png;base64,AA==" } }, appState: {} };

test("realtime upgrade uses current private permissions without persistence effects", { timeout: 60_000 }, async (t) => {
  const f = await persistenceFixture(t);
  const { request } = f;
  const id = "9007199254740993";
  const route = `/api/diagrams/${id}`;
  // Provision an exact full-range identity; all behavior checks use public HTTP.
  await f.setup(`INSERT INTO fixture_schema.diagrams (id, user_id, name, scene_json)
    VALUES ($1, $2, 'shared', $3::jsonb)`, [id, f.users.owner, JSON.stringify(scene)]);
  const initial = await request(route, "owner");
  assert.equal(initial.status, 200);
  assert.equal((await request("/api/files/shared", "owner", "PUT", scene,
    { "If-Match": initial.etag })).status, 200);
  assert.equal((await request(`${route}/members`, "owner", "POST", { username: "member" })).status, 201);

  const snapshot = async () => {
    const accounts = await request("/api/admin/users", "admin");
    const members = await request(`${route}/members`, "owner");
    return { documents: await f.snapshot(id, "shared"), accounts: accounts.body,
      members: { status: members.status, body: members.body } };
  };
  const check = async (room, options, expected) => {
    const before = await snapshot();
    try {
      const result = await realtimeResult(room, options);
      assert.ok(expected.includes(result.status), `expected HTTP ${expected.join("/")}; got ${JSON.stringify(result)}`);
      if (result.status === 101) {
        assert.equal(result.binary, false, JSON.stringify(result));
        assert.deepEqual(JSON.parse(result.body), { type: "ready", diagramId: room });
      } else {
        assert.equal(result.body, "", "upgrade rejection must not expose room content");
      }
    } finally {
      // Includes canonical GET/list/scene, identity ETag/revision, counters and every backup byte.
      assert.deepEqual(await snapshot(), before);
    }
  };
  const cookie = (user) => ({ cookie: f.cookieFor(user) });

  await t.test("owner and registered member receive only exact ready identity", async (t) => {
    for (const user of ["owner", "member"]) {
      await t.test(user, () => check(id, cookie(user), [101]));
    }
  });
  await t.test("persistent peers retain exact ready identity and reject unsupported data", async (t) => {
    for (const [name, user, data] of [
      ["UTF-8 text", "owner", "unsupported-é"],
      ["binary", "member", Buffer.from([0, 1, 255])],
      ["JSON", "member", { type: "unsupported" }],
    ]) {
      await t.test(name, async () => {
        const before = await snapshot();
        const peer = realtimePeer(id, f.cookieFor(user));
        try {
          const ready = await peer.next();
          assert.equal(ready.type, "message");
          assert.equal(ready.binary, false);
          assert.deepEqual(ready.data, Buffer.from(JSON.stringify({ type: "ready", diagramId: id }), "utf8"));
          peer.send(data);
          // Close is the processing boundary: any extra application frame fails here.
          const closed = await peer.next();
          assert.equal(closed.type, "close");
          assert.equal(closed.code, 1008);
          assert.equal(closed.reason, "No data protocol yet");
        } finally {
          try {
            await peer.dispose();
          } finally {
            assert.deepEqual(await snapshot(), before);
          }
        }
      });
    }
  });
  await t.test("anonymous and forged session cookies require authentication", async (t) => {
    for (const [name, options] of [["anonymous", {}], ["forged", { cookie: "excalidraw.sid=s%3Aforged.invalid" }]]) {
      await t.test(name, () => check(id, options, [401]));
    }
  });
  await t.test("authenticated room IDs must be canonical positive BIGINT strings", async (t) => {
    for (const room of ["0", "01", "-1", "1e0", "%20", "9223372036854775808"]) {
      await t.test(room, () => check(room, cookie("owner"), [400]));
    }
  });
  await t.test("missing rooms, strangers and administrators reveal no private room", async (t) => {
    for (const [name, room, user] of [["missing", "9223372036854775807", "owner"],
      ["stranger", id, "stranger"], ["admin has no bypass", id, "admin"]]) {
      await t.test(name, () => check(room, cookie(user), [404]));
    }
  });
  await t.test("explicit same-origin is mandatory even with a valid cookie", async (t) => {
    for (const origin of [null, "http://elsewhere.invalid", "null", "https://127.0.0.1:3035",
      "http://127.0.0.1:3036"]) {
      await t.test(String(origin), () => check(id, { ...cookie("owner"), origin }, [403]));
    }
    await t.test("trusted TLS protocol retains Host authority", () => check(id, {
      ...cookie("owner"), origin: realtimeOrigin.replace("http:", "https:"),
      headers: { "X-Forwarded-Proto": "https" },
    }, [101]));
    await t.test("forwarded host cannot authorize another origin", () => check(id, {
      ...cookie("owner"), origin: "https://elsewhere.invalid",
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "elsewhere.invalid" },
    }, [403]));
  });
  await t.test("cached login cannot upgrade after actor or owner deactivation", async (t) => {
    for (const actor of ["member", "owner"]) {
      await t.test(`inactive ${actor}`, async () => {
        const account = `/api/admin/users/${f.users[actor]}`;
        assert.equal((await request(account, "admin", "PUT", { isActive: false })).status, 200);
        try {
          // Keep the original real-login cookie: no new login or synthetic session.
          // Inactive actors cannot authenticate; an inactive room owner is concealed.
          await check(id, cookie("member"), actor === "member" ? [401] : [404]);
          if (actor === "owner") await check(id, cookie("owner"), [401]);
        } finally {
          assert.equal((await request(account, "admin", "PUT", { isActive: true })).status, 200);
        }
      });
    }
  });
});

test("sync_request has a current private bounded delivery gate", { timeout: 240_000 }, async (t) => {
  await t.test("bidirectional stable identity, no echo and no cross-room disclosure", (t) => syncFixture(t, async ({ f, a, b, c, d, open }) => {
    await relay(a, b, f.users.owner); await relay(b, a, f.users.member); await relay(b, a, f.users.member);
    assert.notEqual(identities.get(a), identities.get(b));
    for (const peer of [a, b, c, d]) { peer.send("unsupported"); await closed(peer, 1008, "No data protocol yet"); }
    const nextOwner = await open("owner"), nextMember = await open("member");
    await relay(nextOwner, nextMember, f.users.owner);
    assert.notEqual(identities.get(nextOwner), identities.get(a), "peer identity is per connection, not per account");
  }));
  const invalid = ["{", "1", "null", "[]", Buffer.from(JSON.stringify(sync)), { type: "sync_request" }, { payload: {} },
    ...[null, [], 1, "", true, { unknown: 1 }].map((payload) => ({ ...sync, payload })),
    ...["sender", "room", "session", "target", "revision", "ETag", "etag", "unknown"].map((key) => ({ ...sync, [key]: "forged" })),
    ...["scene", "pointer", "files"].map((type) => ({ ...sync, type }))];
  for (const [index, value] of invalid.entries()) await t.test(`strict envelope rejection ${index}`, (t) => syncFixture(t, async ({ a, b }) => {
    a.send(value); await closed(a, 1008, "No data protocol yet");
    b.send("unsupported"); await closed(b, 1008, "No data protocol yet");
  }));
  for (const fragmented of [false, true]) await t.test(`25MiB UTF-8 aggregate boundary, fragmented=${fragmented}`, (t) => syncFixture(t, async ({ f, a, b }) => {
    const raw = JSON.stringify(sync).padEnd(limit, " ");
    const send = (text) => fragmented ? (a.send(text.slice(0, limit / 2), { fin: false }), a.send(text.slice(limit / 2), { fin: true })) : a.send(text);
    await relay(a, b, f.users.owner, () => send(raw));
    send(raw + " "); await closed(a, 1009);
    b.send("unsupported"); await closed(b, 1008);
  }));
  const mutations = [
    ["logout", async (f) => assert.equal((await f.request("/api/auth/logout", "member", "POST")).status, 200)],
    ["destroyed session", (f) => f.setup("DELETE FROM fixture_schema.user_sessions WHERE sess::jsonb#>>'{user,id}'=$1", [String(f.users.member)])],
    ["expired session", (f) => f.setup("UPDATE fixture_schema.user_sessions SET expire=NOW()-INTERVAL '1 second' WHERE sess::jsonb#>>'{user,id}'=$1", [String(f.users.member)])],
    ["changed stored identity", (f) => f.setup("UPDATE fixture_schema.user_sessions SET sess=jsonb_set(sess::jsonb,'{user,id}',to_jsonb($1::text)) WHERE sess::jsonb#>>'{user,id}'=$2", [String(f.users.owner), String(f.users.member)])],
    ...["member", "owner"].flatMap((user) => [
      [`inactive ${user}`, async (f) => assert.equal((await f.request(`/api/admin/users/${f.users[user]}`, "admin", "PUT", { isActive: false })).status, 200)],
      [`deleted ${user}`, async (f) => assert.equal((await f.request(`/api/admin/users/${f.users[user]}`, "admin", "DELETE")).status, 200)]]),
    ["revoked member", async (f, route) => assert.equal((await f.request(`${route}/members/member`, "owner", "DELETE")).status, 200)],
    ["deleted diagram", async (f) => assert.equal((await f.request("/api/files/shared", "owner", "DELETE")).status, 200)],
  ];
  for (const [name, mutate] of mutations) for (const recipient of [false, true]) await t.test(`${name}: fresh ${recipient ? "recipient" : "sender"} authorization`, (t) => syncFixture(t, async ({ f, a, b, c, d, route, open, checkpoint }) => {
    await mutate(f, route); await checkpoint();
    if (recipient && !name.includes("owner") && name !== "deleted diagram") {
      const valid = await open("owner"); await relay(a, valid, f.users.owner);
    } else if (recipient && name !== "deleted diagram") a.send(sync);
    if (b.open) b.send(sync); await closed(b, 1008); // Bounds absence even if invalidation already closed it.
    if (a.open) a.send("unsupported"); await closed(a, 1008);
    await relay(c, d, f.users.stranger); // Unaffected peers must still work.
  }));
  for (const recipient of [false, true]) for (const commitFirst of [false, true]) await t.test(`revocation linearization: recipient=${recipient}, commitFirst=${commitFirst}`, (t) => syncFixture(t, async ({ f, a, b, route, checkpoint }) => {
    if (commitFirst) {
      assert.equal((await f.request(`${route}/members/member`, "owner", "DELETE")).status, 200); await checkpoint();
      if (recipient) a.send(sync);
    } else {
      const sender = recipient ? a : b, target = recipient ? b : a;
      const gate = await f.realtimeGate();
      try {
        sender.send(sync); await gate.blocked;
        const revoking = f.request(`${route}/members/member`, "owner", "DELETE"); revoking.catch(() => {});
        await f.blocked(1); // Public revoke is blocked by held authorization row locks.
        gate.release();
        const event = await target.next(); assert.equal(event.type, "message");
        assert.deepEqual(JSON.parse(event.data), { ...sync, sender: { userId: String(f.users[recipient ? "owner" : "member"]), peerId: identities.get(sender) } });
        assert.equal((await revoking).status, 200); await checkpoint();
        if (recipient) a.send(sync);
      } finally { gate.release(); }
    }
    if (b.open) b.send(sync); await closed(b, 1008);
    if (a.open) a.send("unsupported"); await closed(a, 1008);
  }));
  for (const mode of ["eight pending", "nine pending", "byte overload", "outbound pressure", "disconnect"]) await t.test(mode, (t) => syncFixture(t, async ({ f, a, b }) => {
    const gate = await f.realtimeGate();
    try {
      a.send(sync); await gate.blocked;
      if (mode === "disconnect") await a.dispose();
      else if (mode === "byte overload") for (let i = 0; i < 2; i++) a.send(JSON.stringify(sync).padEnd(limit / 2 + 1, " "));
      else if (mode !== "outbound pressure") for (let i = 0; i < (mode === "eight pending" ? 8 : 9); i++) a.send(sync);
      if (mode === "nine pending" || mode === "byte overload") await closed(a, 1013);
      gate.release(mode === "outbound pressure"); // Controlled transport-buffer fault, not a TCP throughput claim.
      if (mode === "eight pending") for (let i = 0; i < 9; i++) {
        const event = await b.next(); assert.equal(event.type, "message");
        assert.deepEqual(JSON.parse(event.data), { ...sync, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
      } // Count/serialization only: empty controls cannot prove distinguishable payload order.
      if (mode === "outbound pressure") await closed(b, 1013);
      else { b.send("unsupported"); await closed(b, 1008); }
      if (mode === "eight pending" || mode === "outbound pressure") { a.send("unsupported"); await closed(a, 1008); }
    } finally { gate.release(); }
  }));
});

const atom = { id: "live", version: 1, versionNonce: Number.MIN_SAFE_INTEGER, isDeleted: false, updated: 0 };
const scenePacket = (elements) => ({ type: "scene", payload: { elements } });
const richScene = scenePacket([{ ...atom, index: null, fileId: "image", updatedAt: "literal-é", extension: { createdAt: "unchanged", items: [null, true, 3] } },
  { ...atom, id: "tombstone", version: Number.MAX_SAFE_INTEGER, versionNonce: Number.MAX_SAFE_INTEGER, isDeleted: true, updated: Number.MAX_VALUE, index: "a1", fileId: null }]);
const sceneFixture = (t, body) => syncFixture(t, async (context) => {
  await relay(context.a, context.b, context.f.users.owner, richScene, richScene); // Fast close1008 RED before any scene barrier.
  await body(context);
}, { maxFrameBytes: limit });

test("scene carriage preserves private ordered JSON without persistence", { timeout: 240_000 }, async (t) => {
  await t.test("owner/member identity, tombstones/extensions, empty arrays, no echo or cross-room frames", (t) => sceneFixture(t, async ({ f, a, b, c, d }) => {
    await relay(b, a, f.users.member, richScene, richScene);
    const empty = scenePacket([]); await relay(a, b, f.users.owner, empty, empty);
    for (const peer of [a, b, c, d]) { peer.send("unsupported"); await closed(peer, 1008, "No data protocol yet"); }
  }));
  const records = [null, [], 1, "x", ...Object.keys(atom).map((key) => Object.fromEntries(Object.entries(atom).filter(([name]) => name !== key))),
    ...[["id", ["", 1]], ["version", [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]],
      ["versionNonce", [1.5, Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, "1", null]],
      ["isDeleted", [0, "false", null]], ["updated", [-1, "0", null]], ["index", [1]], ["fileId", [1]]]
      .flatMap(([key, values]) => values.map((value) => ({ ...atom, [key]: value })))];
  const extras = ["appState", "files", "sender", "room", "session", "target", "ETag", "revision"];
  const invalid = [...records.map((record) => scenePacket([record])), ...[null, {}, 1, "x"].map(scenePacket),
    ...[null, [], 1, {}].map((payload) => ({ type: "scene", payload })),
    ...extras.flatMap((key) => [{ ...richScene, [key]: "forged" }, { ...richScene, payload: { ...richScene.payload, [key]: "forged" } }]),
    JSON.stringify(richScene).replace('"updated":0', '"updated":1e309')];
  for (const [index, value] of invalid.entries()) await t.test(`scene shape/field rejection ${index}`, (t) => sceneFixture(t, async ({ a, b }) => {
    a.send(value); await closed(a, 1008, "No data protocol yet"); b.send("unsupported"); await closed(b, 1008);
  }));
  await t.test("quick distinguishable scenes retain per-sender order", (t) => sceneFixture(t, async ({ f, a, b }) => {
    const frames = [2, 3, 4].map((version) => scenePacket([{ ...atom, version }]));
    for (const frame of frames) a.send(frame);
    for (const frame of frames) { const event = await b.next(); assert.equal(event.type, "message"); assert.deepEqual(JSON.parse(event.data), { ...frame, sender: { userId: String(f.users.owner), peerId: identities.get(a) } }); }
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  await t.test("scene enqueue locks revocation, then excludes stale recipient/sender while valid delivery continues", (t) => sceneFixture(t, async ({ f, a, b, route, open, checkpoint }) => {
    const gate = await f.realtimeGate();
    try {
      a.send(richScene); await gate.blocked;
      const revoking = f.request(`${route}/members/member`, "owner", "DELETE"); revoking.catch(() => {});
      await f.blocked(1); gate.release();
      const event = await b.next(); assert.equal(event.type, "message"); assert.deepEqual(JSON.parse(event.data), { ...richScene, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
      assert.equal((await revoking).status, 200); await checkpoint();
      const valid = await open("owner"); await relay(a, valid, f.users.owner, richScene, richScene);
      if (b.open) b.send(richScene); await closed(b, 1008);
      for (const peer of [a, valid]) { peer.send("unsupported"); await closed(peer, 1008); }
    } finally { gate.release(); }
  }));
  await t.test("encoded output exactly25MiB passes; one extra UTF-8 byte below input cap closes1009", (t) => sceneFixture(t, async ({ f, a, b }) => {
    const value = structuredClone(richScene); value.payload.elements[0].padding = "";
    const encoded = () => JSON.stringify({ ...value, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
    const remaining = limit - Buffer.byteLength(encoded()); value.payload.elements[0].padding = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    assert.equal(Buffer.byteLength(encoded()), limit); await relay(a, b, f.users.owner, value, value);
    value.payload.elements[0].padding += "x"; assert.equal(Buffer.byteLength(encoded()), limit + 1); assert.ok(Buffer.byteLength(JSON.stringify(value)) < limit);
    a.send(value); await closed(a, 1009); b.send("unsupported"); await closed(b, 1008);
  }));
  for (const fragmented of [false, true]) await t.test(`scene raw UTF-8 input25MiB/+1, fragmented=${fragmented}`, (t) => sceneFixture(t, async ({ f, a, b }) => {
    let raw = JSON.stringify(richScene); raw = raw.padEnd(raw.length + limit - Buffer.byteLength(raw), " "); assert.equal(Buffer.byteLength(raw), limit);
    const send = (text) => fragmented ? (a.send(text.slice(0, limit / 2), { fin: false }), a.send(text.slice(limit / 2), { fin: true })) : a.send(text);
    await relay(a, b, f.users.owner, () => send(raw), richScene);
    send(raw + " "); await closed(a, 1009); b.send("unsupported"); await closed(b, 1008);
  }));
});

const pointerPacket = (x = 0, y = -0.5, tool = "pointer", button = "up") => ({ type: "pointer", payload: { pointer: { x, y, tool }, button } });
const pointer = pointerPacket();
const pointerFixture = (t, body) => syncFixture(t, async (context) => {
  // Every leaf must hit actual pointer close1008 RED before arming any feature barrier.
  await relay(context.a, context.b, context.f.users.owner, pointer, pointer);
  await body(context);
});

test("pointer carriage preserves exact private ephemeral coordinates", { timeout: 240_000 }, async (t) => {
  for (const tool of ["pointer", "laser"]) for (const button of ["up", "down"]) {
    await t.test(`bidirectional ${tool}/${button}, stable identity, no echo or cross-room frames`, (t) => pointerFixture(t, async ({ f, a, b, c, d }) => {
      const value = pointerPacket(-12.75, 0, tool, button);
      await relay(a, b, f.users.owner, value, value);
      await relay(b, a, f.users.member, value, value);
      await relay(b, a, f.users.member, value, value);
      assert.notEqual(identities.get(a), identities.get(b));
      for (const peer of [a, b, c, d]) { peer.send("unsupported"); await closed(peer, 1008, "No data protocol yet"); }
    }));
  }
  await t.test("finite coordinate extremes, zero and fractions have no viewport or integer bounds", (t) => pointerFixture(t, async ({ f, a, b }) => {
    for (const [x, y] of [[Number.MAX_VALUE, -Number.MAX_VALUE], [-Number.MAX_VALUE, Number.MAX_VALUE], [0, 0], [-0.125, Number.MIN_VALUE]]) {
      const value = pointerPacket(x, y); await relay(a, b, f.users.owner, value, value);
    }
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  const invalid = [];
  for (const [level, base, wrap] of [
    ["envelope", pointer, (value) => value],
    ["payload", pointer.payload, (payload) => ({ ...pointer, payload })],
    ["coordinates", pointer.payload.pointer, (value) => ({ ...pointer, payload: { ...pointer.payload, pointer: value } })],
  ]) {
    for (const key of Object.keys(base)) invalid.push([`${level} missing ${key}`, wrap(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)))]);
    for (const value of [null, [], 1, "x", true]) invalid.push([`${level} rejects ${JSON.stringify(value)}`, wrap(value)]);
    for (const key of ["pointersMap", "identity", "userId", "peerId", "sender", "room", "session", "target", "revision", "ETag", "selection", "appearance", "unknown"]) {
      invalid.push([`${level} forbids extra ${key}`, wrap({ ...base, [key]: "forged" })]);
    }
  }
  for (const key of ["x", "y", "tool", "button", "type"]) {
    const values = key === "x" || key === "y" ? [null, [], {}, true, "0"] : [null, [], {}, true, 1, "", "POINTER", "other"];
    for (const value of values) {
      const packet = structuredClone(pointer);
      if (key === "type") packet.type = value;
      else if (key === "button") packet.payload.button = value;
      else packet.payload.pointer[key] = value;
      invalid.push([`${key} rejects ${JSON.stringify(value)}`, packet]);
    }
  }
  for (const key of ["x", "y"]) for (const exponent of ["1e309", "-1e309"]) {
    invalid.push([`${key} rejects raw ${exponent}`, JSON.stringify(pointer).replace(key === "x" ? '"x":0' : '"y":-0.5', `"${key}":${exponent}`)]);
  }
  for (const [name, value] of invalid) await t.test(name, (t) => pointerFixture(t, async ({ a, b }) => {
    a.send(value); await closed(a, 1008, "No data protocol yet");
    b.send("unsupported"); await closed(b, 1008, "No data protocol yet");
  }));
  await t.test("quick distinguishable coordinates and buttons remain FIFO", (t) => pointerFixture(t, async ({ f, a, b }) => {
    const frames = [pointerPacket(1, -1, "laser", "down"), pointerPacket(2.5, 3, "pointer", "up"), pointerPacket(-4, 0, "laser", "up")];
    for (const frame of frames) a.send(frame);
    for (const frame of frames) {
      const event = await b.next(); assert.equal(event.type, "message");
      assert.deepEqual(JSON.parse(event.data), { ...frame, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
    }
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  await t.test("pointer enqueue locks revocation before commit, then excludes stale recipient and sender", (t) => pointerFixture(t, async ({ f, a, b, route, open, checkpoint }) => {
    const gate = await f.realtimeGate();
    try {
      a.send(pointer); await gate.blocked;
      const revoking = f.request(`${route}/members/member`, "owner", "DELETE"); revoking.catch(() => {});
      await f.blocked(1); gate.release();
      const event = await b.next(); assert.equal(event.type, "message");
      assert.deepEqual(JSON.parse(event.data), { ...pointer, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
      assert.equal((await revoking).status, 200); await checkpoint(); // Only intentional public ACL effects advance the snapshot.
      const valid = await open("owner"); await relay(a, valid, f.users.owner, pointer, pointer);
      if (b.open) b.send(pointer); await closed(b, 1008); // Any stale-recipient data before denial fails.
      for (const peer of [a, valid]) { peer.send("unsupported"); await closed(peer, 1008); }
    } finally { gate.release(); }
  }));
  for (const fragmented of [false, true]) await t.test(`pointer raw input25MiB/+1, fragmented=${fragmented}`, (t) => pointerFixture(t, async ({ f, a, b }) => {
    const raw = JSON.stringify(pointer).padEnd(limit, " ");
    const send = (text) => fragmented ? (a.send(text.slice(0, limit / 2), { fin: false }), a.send(text.slice(limit / 2), { fin: true })) : a.send(text);
    await relay(a, b, f.users.owner, () => send(raw), pointer);
    send(raw + " "); await closed(a, 1009); b.send("unsupported"); await closed(b, 1008);
  }));
});

const fileRecord = { id: "unreferenced/é", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 0 };
const filesPacket = (files) => ({ type: "files", payload: { files } });
const filePacket = (record) => filesPacket({ [record.id]: record });
const files = filePacket(fileRecord);
const filesFixture = (t, body) => syncFixture(t, async (context) => {
  await relay(context.a, context.b, context.f.users.owner, files, files); // Fast baseline close1008 BEFORE any file barrier.
  await body(context);
}, { maxFrameBytes: limit });

test("file carriage preserves exact private binary records without persistence", { timeout: 480_000 }, async (t) => {
  // Installed IMAGE_MIME_TYPES plus MIME_TYPES.binary; no decoder or media-safety oracle.
  for (const mimeType of ["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif", "image/jfif", "application/octet-stream"]) {
    await t.test(`bidirectional ${mimeType}, exact bytes, identity, no echo or cross-room frames`, (t) => filesFixture(t, async ({ f, a, b, c, d }) => {
      const value = filePacket({ ...fileRecord, mimeType, dataURL: `data:${mimeType};charset=utf-8;custom=literal,é%00/+=\nuntouched` });
      await relay(a, b, f.users.owner, value, value); await relay(b, a, f.users.member, value, value);
      await relay(b, a, f.users.member, value, value); assert.notEqual(identities.get(a), identities.get(b));
      for (const peer of [a, b, c, d]) { peer.send("unsupported"); await closed(peer, 1008, "No data protocol yet"); }
    }));
  }
  await t.test("optional timestamps/version, finite extremes and arbitrary JSON metadata stay unchanged", (t) => filesFixture(t, async ({ f, a, b }) => {
    for (const created of [0, 0.125, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const value = filePacket({ ...fileRecord, created, lastRetrieved: created, version: Number.MAX_SAFE_INTEGER,
        sender: "metadata-only", room: "not-routing", revision: 9, extension: { updatedAt: "literal-not-clock", createdAt: "unchanged", items: [null, true, { deleted: true }] } });
      await relay(a, b, f.users.owner, value, value);
    }
    const plain = filePacket({ ...fileRecord, dataURL: "data:image/png,not-base64-or-decoded" });
    await relay(b, a, f.users.member, plain, plain);
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  await t.test("empty map and multiple arbitrary own IDs need no scene references or digest format", (t) => filesFixture(t, async ({ f, a, b }) => {
    for (const value of [filesPacket({}), filesPacket(Object.fromEntries(["__proto__", "constructor", " ", "deleted-image"].map((id) => [id, { ...fileRecord, id }])))]) {
      await relay(a, b, f.users.owner, value, value);
    }
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  const invalid = [];
  for (const [level, base, wrap] of [["envelope", files, (value) => value], ["payload", files.payload, (payload) => ({ ...files, payload })],
    ["record", fileRecord, (record) => filesPacket({ [fileRecord.id]: record })]]) {
    for (const key of Object.keys(base)) invalid.push([`${level} missing ${key}`, wrap(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)))]);
    for (const value of [null, [], 1, "x", true]) invalid.push([`${level} rejects ${JSON.stringify(value)}`, wrap(value)]);
    if (level !== "record") for (const key of ["sender", "userId", "peerId", "room", "session", "target", "token", "revision", "ETag", "unknown"]) {
      invalid.push([`${level} forbids extra ${key}`, wrap({ ...base, [key]: "forged" })]);
    }
  }
  for (const value of [null, [], 1, "x", true]) invalid.push([`file map rejects ${JSON.stringify(value)}`, filesPacket(value)]);
  invalid.push(["empty map key", filesPacket({ "": { ...fileRecord, id: "" } })], ["map key/id mismatch", filesPacket({ different: fileRecord })]);
  for (const [key, values] of [
    ["id", ["", null, [], {}, 1, true]],
    ["mimeType", ["image/PNG", "text/plain", "application/json", "", null, [], {}, 1, true]],
    ["dataURL", [null, [], {}, 1, true, "", "data:image/jpeg,body", "data:IMAGE/PNG,body", "DATA:image/png,body", " data:image/png,body", "data:image/png", "data:image/png,", "data:image/png;base64,", "data:image/png-extra,body"]],
    ...["created", "lastRetrieved"].map((key) => [key, [-1, -Number.MIN_VALUE, "0", null, [], {}, true]]),
    ["version", [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null, [], {}, true]],
  ]) for (const value of values) invalid.push([`${key} rejects ${JSON.stringify(value)}`, filesPacket({ [fileRecord.id]: { ...fileRecord, [key]: value } })]);
  for (const key of ["created", "lastRetrieved"]) for (const exponent of ["1e309", "-1e309"]) {
    const value = filePacket({ ...fileRecord, lastRetrieved: 0 });
    invalid.push([`${key} rejects raw ${exponent}`, JSON.stringify(value).replace(`"${key}":0`, `"${key}":${exponent}`)]);
  }
  for (const [name, value] of invalid) await t.test(name, (t) => filesFixture(t, async ({ a, b }) => {
    a.send(value); await closed(a, 1008, "No data protocol yet"); b.send("unsupported"); await closed(b, 1008, "No data protocol yet");
  }));
  await t.test("quick actual dataURL bytes and metadata remain FIFO", (t) => filesFixture(t, async ({ f, a, b }) => {
    const frames = [1, 2, 3].map((version) => filePacket({ ...fileRecord, dataURL: `data:image/png,é-frame-${version}`, version, extension: { updatedAt: `literal-${version}` } }));
    for (const frame of frames) a.send(frame);
    for (const frame of frames) {
      const event = await b.next(); assert.equal(event.type, "message");
      assert.deepEqual(JSON.parse(event.data), { ...frame, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
    }
    a.send("unsupported"); await closed(a, 1008); b.send("unsupported"); await closed(b, 1008);
  }));
  await t.test("file enqueue locks revocation before commit, then excludes stale recipient/sender while valid delivery continues", (t) => filesFixture(t, async ({ f, a, b, route, open, checkpoint }) => {
    const gate = await f.realtimeGate();
    try {
      a.send(files); await gate.blocked;
      const revoking = f.request(`${route}/members/member`, "owner", "DELETE"); revoking.catch(() => {});
      await f.blocked(1); gate.release();
      const event = await b.next(); assert.equal(event.type, "message");
      assert.deepEqual(JSON.parse(event.data), { ...files, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
      assert.equal((await revoking).status, 200); await checkpoint(); // Only intentional public ACL effects advance the snapshot.
      const valid = await open("owner"); await relay(a, valid, f.users.owner, files, files);
      if (b.open) b.send(files); await closed(b, 1008); // Any stale-recipient data before denial fails.
      for (const peer of [a, valid]) { peer.send("unsupported"); await closed(peer, 1008); }
    } finally { gate.release(); }
  }));
  await t.test("actual file encoded output exactly25MiB passes; +1 UTF-8 byte below input cap closes1009 without delivery", (t) => filesFixture(t, async ({ f, a, b }) => {
    const value = structuredClone(files), record = value.payload.files[fileRecord.id];
    const encoded = () => JSON.stringify({ ...value, sender: { userId: String(f.users.owner), peerId: identities.get(a) } });
    const remaining = limit - Buffer.byteLength(encoded()); record.dataURL += "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    assert.equal(Buffer.byteLength(encoded()), limit); assert.ok(Buffer.byteLength(JSON.stringify(value)) < limit);
    await relay(a, b, f.users.owner, value, value);
    record.dataURL += "x"; assert.equal(Buffer.byteLength(encoded()), limit + 1); assert.ok(Buffer.byteLength(JSON.stringify(value)) < limit);
    a.send(value); await closed(a, 1009); b.send("unsupported"); await closed(b, 1008);
  }));
});

// Snapshot accounts keep their own login SIDs: public reads must never roll the
// SID whose expiry is under test. Existing mutation cases above cover changed
// stored identity, logout and deletion on the very next sender/recipient frame.
for (const renewal of [false, true]) test(`session boundary: ${renewal ? "HTTP rolling renewal, never WS renewal" : "inclusive ceiling-second expiry"}`, { timeout: 60_000 }, async (t) => {
  const f = await persistenceFixture(t, { realtime: true });
  assert.equal((await f.request("/api/files/shared", "owner", "PUT", scene)).status, 200);
  const id = (await f.request("/api/diagrams", "owner")).body.diagrams[0].id;
  const route = `/api/diagrams/${id}`;
  assert.equal((await f.request(`${route}/members`, "owner", "POST", { username: "member" })).status, 201);
  await f.loginAs("probe", "member");
  const sid = decodeURIComponent(f.cookieFor("probe").split("=")[1]).slice(2).split(".")[0];
  const row = async () => (await f.setup(`SELECT sid, sess, EXTRACT(EPOCH FROM expire::timestamptz) AS expires
    FROM fixture_schema.user_sessions WHERE sid=$1`, [sid])).rows[0];
  // Only this isolated SID is shortened. DB NOW() is not a fake-time source.
  const expiry = Math.ceil(Date.now() / 1000) + 120;
  await f.setup("UPDATE fixture_schema.user_sessions SET expire=to_timestamp($1) WHERE sid=$2", [expiry, sid]);
  const initial = await row();
  const snapshot = async () => ({ documents: await f.snapshot(id, "shared"),
    accounts: await f.request("/api/admin/users", "admin"), members: await f.request(`${route}/members`, "owner") });
  const before = await snapshot();
  const streams = f.streams();
  assert.match(streams.stdout, /Excalidraw auth server listening/);
  assert.equal(streams.stderr, "");
  assert.equal(f.logs(), streams.stdout); // Known setup stdout is not an error.
  const peers = [];
  const open = async (user) => {
    const peer = realtimePeer(id, f.cookieFor(user)); peers.push(peer);
    const ready = await peer.next();
    assert.deepEqual(ready, { type: "message", binary: false,
      data: Buffer.from(JSON.stringify({ type: "ready", diagramId: id })) });
    return peer;
  };
  try {
    const observed = await f.realtimeObserve((expiry - 1) * 1000);
    assert.equal(observed.now, (expiry - 1) * 1000);
    const a = await open("probe"), b = await open("owner");
    // Real relay completion is the oracle, not a quiet interval or timer expiry.
    const gate = await f.realtimeGate();
    const delivery = relay(a, b, f.users.member); delivery.catch(() => {});
    try {
      await gate.blocked;
      const atBoundary = await f.realtimeObserve(expiry * 1000);
      assert.equal(atBoundary.now, expiry * 1000);
      gate.release(); await delivery;
    } finally { gate.release(); }
    assert.deepEqual(await row(), initial, "admission and relay preserve expiry and session payload");
    assert.deepEqual((await f.realtimeObserve(expiry * 1000)).writes, observed.writes, "WS never saves or touches sessions");
    if (renewal) {
      const rolling = await f.request("/api/auth/session", "probe", "GET", undefined, {}, true);
      assert.equal(rolling.status, 200);
      assert.deepEqual(rolling.body, { authenticated: true, user: initial.sess.user });
      assert.equal(rolling.cookie, f.cookieFor("probe"));
      const { default: responseETag } = await import("etag");
      assert.equal(rolling.etag, responseETag(JSON.stringify(rolling.body), { weak: true }));
      assert.equal(rolling.warning, null);
      const renewed = await row();
      const nextExpiry = Math.ceil((expiry * 1000 + initial.sess.cookie.originalMaxAge) / 1000);
      assert.equal(Number(renewed.expires), nextExpiry); assert.ok(nextExpiry > expiry);
      assert.deepEqual(renewed.sess, initial.sess, "rolling touch does not rewrite stored payload");
      const cookieExpiry = new Date(expiry * 1000 + initial.sess.cookie.originalMaxAge).toUTCString();
      assert.equal(rolling.headers["set-cookie"], `${f.cookieFor("probe")}; Path=/; Expires=${cookieExpiry}; HttpOnly; SameSite=Lax`);
      assert.deepEqual((await f.realtimeObserve(expiry * 1000 + 1)).writes, [...observed.writes, "UPDATE"]);
      await relay(a, b, f.users.member, files, files); // Opaque bytes beyond the former expiry.
      assert.deepEqual(await row(), renewed);
      assert.deepEqual((await f.realtimeObserve(expiry * 1000 + 1)).writes, [...observed.writes, "UPDATE"]);
      a.send("unsupported"); await closed(a, 1008, "No data protocol yet");
    } else {
      const nextBoundary = await f.realtimeObserve(expiry * 1000 + 1);
      assert.equal(Math.ceil(nextBoundary.now / 1000), expiry + 1);
      a.send(sync); await closed(a, 1008, "Access denied");
      assert.deepEqual(await row(), initial);
      assert.deepEqual((await f.realtimeObserve(expiry * 1000 + 1)).writes, observed.writes);
    }
    b.send("unsupported"); await closed(b, 1008, "No data protocol yet");
  } finally {
    await f.realtimeObserve();
    try { await Promise.all(peers.map((peer) => peer.dispose())); }
    finally {
      assert.deepEqual(await snapshot(), before);
      assert.equal(f.streams().stderr, "");
    }
  }
});


// C1a only. Every subject proves ready+relay before an idle mutation/fault.
const idleFixture = async (t, body, acknowledgeClose = true) => {
  const f = await persistenceFixture(t, { realtime: true });
  for (const [user, name] of [["owner", "shared"], ["owner", "second"], ["stranger", "shared"]])
    assert.equal((await f.request(`/api/files/${name}`, user, "PUT", scene)).status, 200);
  const rooms = (await f.request("/api/diagrams", "owner")).body.diagrams;
  const id = rooms.find((room) => room.name === "shared").id, second = rooms.find((room) => room.name === "second").id;
  const other = (await f.request("/api/diagrams", "stranger")).body.diagrams[0].id;
  for (const room of [id, second]) assert.equal((await f.request(`/api/diagrams/${room}/members`, "owner", "POST", { username: "member" })).status, 201);
  await f.loginAs("probe", "member"); await f.loginAs("probe2", "member"); await f.loginAs("arrival", "stranger");
  const sid = (user) => decodeURIComponent(f.cookieFor(user).split("=")[1]).slice(2).split(".")[0];
  const row = async (user = "probe") => (await f.setup("SELECT * FROM fixture_schema.user_sessions WHERE sid=$1", [sid(user)])).rows;
  const snapshot = async () => ({ primary: await f.snapshot(id, "shared"),
    secondary: await Promise.all(["owner", "member"].map((user) => f.request(`/api/diagrams/${second}`, user))),
    other: await f.request(`/api/diagrams/${other}`, "stranger"), accounts: await f.request("/api/admin/users", "admin"),
    members: await Promise.all([id, second].map((room) => f.request(`/api/diagrams/${room}/members`, "owner"))) });
  let expected = await snapshot(), inactiveActor;
  const checkpoint = async (actor, isActive, user, login = false) => {
    const previous = expected.accounts.body.users.find((item) => item.id === f.users[actor]);
    assert.deepEqual(user, { ...previous, diagramCount: 0, isActive, updatedAt: user.updatedAt, ...(login ? { lastLoginAt: user.lastLoginAt } : {}) });
    expected.accounts.body.users = expected.accounts.body.users.map((item) => item.id === user.id ? { ...previous, isActive, updatedAt: user.updatedAt, lastLoginAt: user.lastLoginAt } : item);
    const { default: responseETag } = await import("etag"); expected.accounts.etag = responseETag(JSON.stringify(expected.accounts.body), { weak: true });
    if (!isActive) inactiveActor = actor;
  };
  const restore = async () => {
    if (!inactiveActor) return;
    const actor = inactiveActor;
    const activate = async (login = false) => {
      const result = await f.request(`/api/admin/users/${f.users[actor]}`, "admin", "PUT", { isActive: true });
      assert.equal(result.status, 200); await checkpoint(actor, true, result.body.user, login);
    };
    await activate(); await f.loginAs("restored", actor); await activate(true);
    for (const room of [id, second]) assert.deepEqual(await f.request(`/api/diagrams/${room}`, "restored"), { ...await f.request(`/api/diagrams/${room}`, actor), cookie: f.cookieFor("restored") });
    inactiveActor = undefined;
  };
  const peers = [], roomOf = new WeakMap();
  const open = async (user, room = id, ack = true) => {
    const peer = realtimePeer(room, f.cookieFor(user), { deadlineMs: 7200, acknowledgeClose: ack }); peers.push(peer); roomOf.set(peer, room);
    assert.deepEqual(await peer.next(), { type: "message", binary: false, data: Buffer.from(JSON.stringify({ type: "ready", diagramId: room })) });
    return peer;
  };
  const fanout = async (sender, target, userId) => {
    const recipients = peers.filter((peer) => peer !== sender && peer.open && roomOf.get(peer) === roomOf.get(sender));
    assert.ok(recipients.includes(target));
    const delivery = Promise.all(recipients.map((peer) => peer.next()));
    try {
      const result = Promise.race([delivery, sender.next(false).then(() => assert.fail("no sender echo"))]);
      sender.send(sync);
      const events = await result, frame = JSON.parse(events[0].data);
      assert.equal(typeof frame.sender?.peerId, "string"); assert.ok(frame.sender.peerId.length > 0);
      const peerId = identities.get(sender) ?? frame.sender.peerId; identities.set(sender, peerId);
      for (const event of events) assert.deepEqual(event, { type: "message", binary: false,
        data: Buffer.from(JSON.stringify({ type: sync.type, sender: { userId: String(userId), peerId }, payload: sync.payload })) });
    } finally { sender.cancelRead(); recipients.forEach((peer) => peer.cancelRead()); }
  };
  let failure;
  try {
    const a = await open("probe", id, acknowledgeClose), b = await open("owner");
    await fanout(a, b, f.users.member); await fanout(b, a, f.users.owner);
    await body({ f, a, b, id, second, other, open, sid, row, fanout, checkpoint, restore, snapshot });
    for (const peer of peers.filter((peer) => peer.open)) { peer.send("unsupported"); await closed(peer, 1008, "No data protocol yet"); }
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      await restore(); // Also restore on baseline idle-rule failure, without masking it with inaccessible snapshots.
      await f.realtimeControl("release");
      try { await Promise.all(peers.map((peer) => peer.dispose())); }
      finally { assert.deepEqual(await snapshot(), expected); }
    } catch (cleanupError) { if (!failure) throw cleanupError; failure.cause ??= cleanupError; }
  }
};
const idleDenied = async (peer, since) => {
  await closed(peer, 1008, "Access denied");
  assert.ok(performance.now() - since <= 7200, "transport retirement <=7s plus 200ms harness margin");
};
for (const mode of ["logout", "actor inactive", "owner inactive", "removed", "identity mismatch", "expired", "nonack"])
  test(`idle authorization: ${mode}`, { timeout: 20_000 }, (t) => idleFixture(t, async ({ f, a, b, id, second, other, open, sid, row, checkpoint, restore, fanout }) => {
    const duplicate = await open("probe", second), owner2 = await open("owner", second);
    await fanout(duplicate, owner2, f.users.member);
    const alternate = await open("probe2"), alternate2 = await open("probe2", second);
    await fanout(alternate, b, f.users.member); await fanout(alternate2, owner2, f.users.member);
    const c = await open("stranger", other), d = await open("stranger", other);
    await fanout(c, d, f.users.stranger);
    const since = performance.now();
    if (mode === "logout" || mode === "nonack") {
      const result = await f.request("/api/auth/logout", "probe", "POST", undefined, {}, true);
      assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true });
      assert.match(result.headers["set-cookie"], /^excalidraw\.sid=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      assert.deepEqual(await row(), []);
    } else if (mode.endsWith("inactive")) {
      const actor = mode.startsWith("actor") ? "member" : "owner";
      const result = await f.request(`/api/admin/users/${f.users[actor]}`, "admin", "PUT", { isActive: false });
      assert.equal(result.status, 200); assert.equal(result.body.user.isActive, false); await checkpoint(actor, false, result.body.user);
    } else if (mode === "removed") await f.setup("DELETE FROM fixture_schema.user_sessions WHERE sid=$1", [sid("probe")]);
    else if (mode === "identity mismatch") await f.setup("UPDATE fixture_schema.user_sessions SET sess=jsonb_set(sess::jsonb,'{user,id}',to_jsonb($1::text)) WHERE sid=$2", [String(f.users.owner), sid("probe")]);
    else await f.setup("UPDATE fixture_schema.user_sessions SET expire=NOW()-INTERVAL '1 second' WHERE sid=$1", [sid("probe")]);
    const stored = await row(); // Do not roll the subject SID through HTTP snapshots.
    const doomed = mode.endsWith("inactive") ? [a, duplicate, alternate, alternate2, ...(mode === "owner inactive" ? [b, owner2] : [])] : [a, duplicate];
    await Promise.all(doomed.map((peer) => idleDenied(peer, since)));
    await restore(); // Public document/ETag/revision/membership snapshots remain the original oracle.
    if (mode === "nonack") {
      const { closeFrame, transportEnd } = a.retirement;
      assert.deepEqual({ code: closeFrame?.code, reason: closeFrame?.reason }, { code: 1008, reason: "Access denied" });
      assert.equal(typeof transportEnd, "number", "actual remote TCP end, not self-disposal");
      assert.ok(transportEnd - closeFrame.at <= 1200, "one-second force-termination grace + harness margin");
    }
    if (!mode.endsWith("inactive")) { await fanout(alternate, b, f.users.member); await fanout(alternate2, owner2, f.users.member); }
    else if (mode === "actor inactive") { const valid = await open("owner", id); await fanout(b, valid, f.users.owner); }
    await fanout(c, d, f.users.stranger); await fanout(d, c, f.users.stranger);
    assert.deepEqual(await row(), stored); assert.equal(f.streams().stderr, "");
  }, mode !== "nonack"));

for (const mode of ["audit-error", "query-stall", "pool-stall"])
  test(`idle unavailable authorization: ${mode}`, { timeout: 20_000 }, (t) => idleFixture(t, async ({ f, a, b, other, open, sid, row, fanout }) => {
    await b.dispose(); // Only the proven subject exists when the next acquisition is armed.
    const stored = await row();
    const fault = await f.realtimeControl("arm", { mode, sid: sid("probe") });
    const since = performance.now();
    // Subscribe before arming; absent baseline audits cannot become setup RED.
    const progress = (async () => {
      if (!await fault.observed) return;
      const c = await open("stranger", other), d = await open("stranger", other);
      await fanout(c, d, f.users.stranger); await fanout(d, c, f.users.stranger);
      const newcomer = await open("arrival", other); await fanout(newcomer, c, f.users.stranger);
      const start = performance.now(); await f.setup("DELETE FROM fixture_schema.user_sessions WHERE sid=$1", [sid("arrival")]);
      await idleDenied(newcomer, start); await fanout(c, d, f.users.stranger);
    })();
    progress.catch(() => {});
    try {
      await idleDenied(a, since); await progress;
      const state = await f.realtimeControl("status");
      assert.equal(state.consumed, 1); assert.equal(state.earlyRelease, 0);
      if (mode === "query-stall") { assert.equal(state.pending, 1); assert.equal(state.matches, 1, "one pending audit per peer"); }
      if (mode === "pool-stall") { assert.equal(state.pending, 1); assert.equal(state.matches, 0, "no overlapping audit while acquisition is pending"); }
      assert.deepEqual(await row(), stored); assert.equal(f.streams().stderr, "");
      await f.realtimeControl("release");
      if (mode !== "audit-error") {
        const settled = await fault.settled;
        assert.ok(settled, "consumed acquisition/query eventually releases its client");
        assert.equal(settled.earlyRelease, 0);
        if (mode === "query-stall") { assert.equal(settled.queryDone, true); assert.equal(settled.rollbackDone, true); }
      }
    } finally { await f.realtimeControl("release"); fault.cancel(); await progress; }
  }));

for (const mode of ["logout-error", "deactivate-error"])
  test(`failed lifecycle preserves valid idle peers: ${mode}`, { timeout: 20_000 }, (t) => idleFixture(t, async ({ f, a, b, open, sid, row, fanout }) => {
    const stored = await row();
    const fault = await f.realtimeControl("arm", { mode, sid: sid("probe"), actor: String(f.users.member) });
    const result = mode === "logout-error" ? await f.request("/api/auth/logout", "probe", "POST", undefined, {}, true)
      : await f.request(`/api/admin/users/${f.users.member}`, "admin", "PUT", { isActive: false }, {}, true);
    assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "Se produjo un error interno en el servidor." });
    assert.equal(result.warning, null); assert.match(result.headers["content-type"], /^application\/json; charset=utf-8$/);
    const { default: responseETag } = await import("etag");
    assert.equal(result.etag, responseETag(JSON.stringify(result.body), { weak: true }));
    assert.equal(result.headers["content-length"], String(Buffer.byteLength(JSON.stringify(result.body))));
    assert.ok(!result.headers["set-cookie"]?.startsWith("excalidraw.sid=;"), "failed logout never clears cookie");
    const status = await f.realtimeControl("status"); assert.equal(status.consumed, 1);
    assert.ok(await fault.observed); fault.cancel();
    await f.realtimeControl("release"); assert.deepEqual(await row(), stored);
    await fanout(a, b, f.users.member); await fanout(b, a, f.users.owner);
    // A distinct invalid idle SID supplies an actual audit boundary; a quiet
    // interval alone is never evidence that the valid subject stayed authorized.
    const sentinel = await open("probe2"); await fanout(sentinel, b, f.users.member);
    const since = performance.now(); await f.setup("DELETE FROM fixture_schema.user_sessions WHERE sid=$1", [sid("probe2")]);
    await idleDenied(sentinel, since); await fanout(a, b, f.users.member);
    assert.deepEqual(await row(), stored);
    assert.equal(f.streams().stderr, status.expectedError, "only the exact intentional error stack is logged");
  }));

// C1b: real native HTTP close, never synthetic close events or teardown as proof.
import { pendingRealtimeUpgrade } from "./helpers/realtime-peer.mjs";
for (const mode of ["query-stall", "pool-stall", "upgrade-stall"])
  test(`real server shutdown: ${mode}`, { timeout: 20_000 }, async (t) => {
    const f = await persistenceFixture(t, { realtime: true });
    assert.equal((await f.request("/api/files/shutdown", "owner", "PUT", scene)).status, 200);
    const id = (await f.request("/api/diagrams", "owner")).body.diagrams[0].id;
    const peers = [];
    let fault, raw;
    try {
      for (const acknowledgeClose of [true, false]) {
        const peer = realtimePeer(id, f.cookieFor("owner"), { acknowledgeClose, deadlineMs: 1700,
          deadlineMessage: "Realtime shutdown admitted transport did not retire" });
        peers.push(peer);
        assert.deepEqual(await peer.next(), { type: "message", binary: false,
          data: Buffer.from(JSON.stringify({ type: "ready", diagramId: id })) });
      }
      await relay(peers[0], peers[1], f.users.owner);
      await relay(peers[1], peers[0], f.users.owner);
      const sid = decodeURIComponent(f.cookieFor("owner").split("=")[1]).slice(2).split(".")[0];
      fault = await f.realtimeControl("arm", { mode, sid, actor: String(f.users.owner) });
      if (mode === "upgrade-stall") raw = pendingRealtimeUpgrade(id, f.cookieFor("owner"));
      assert.ok(await fault.observed, "existing query/acquisition fault reached before shutdown");
      const before = await f.realtimeShutdown("status");
      assert.equal(before.timers.filter((kind) => kind === "interval").length, 2);
      const stopped = await f.realtimeShutdown("close");
      assert.equal(stopped.returnedServer, true, "native close returns its HTTP server");
      assert.equal(stopped.listening, false, "actual close stops listening synchronously");
      if (raw) await raw.waitEnd(); // Baseline must fail this rule, not a future production marker.
      const events = await Promise.all(peers.map((peer) => peer.next()));
      for (const event of events) assert.deepEqual(event, { type: "close", code: 1008, reason: "Access denied" });
      const { closeFrame, transportEnd } = peers[1].retirement;
      assert.equal(typeof transportEnd, "number", "nonack remote TCP end before test teardown");
      assert.ok(transportEnd - closeFrame.at <= 1200, "existing one-second termination grace");
      const ended = await f.realtimeShutdown("closed");
      assert.deepEqual(ended.closeEvents, ["close", "callback"], "real close event and native success callback");
      assert.deepEqual(ended.timers, [], "realtime watchdogs and reapers actually removed");
      assert.ok(ended.timerCounts.timeout > 0, "force-retirement reaper was actually scheduled");
      if (raw) assert.equal(typeof raw.state().remoteEnd, "number");
    } finally {
      await f.realtimeControl("release"); // Disarm first; retain token/record until SQL and rollback settle.
      try {
        if (fault) {
          const settled = await fault.settled;
          assert.ok(settled, "pending work settles even after native HTTP close");
          assert.equal(settled.pending, 0);
          assert.equal(settled.earlyRelease, 0);
          if (mode !== "pool-stall" || settled.began) assert.equal(settled.queryDone, true);
          if (settled.began) assert.equal(settled.rollbackDone, true);
          fault.cancel();
        }
        if (raw) {
          assert.doesNotMatch(raw.state().response, /HTTP\/1\.1 101|"type":"ready"/, "no late admission after stop/release");
          assert.deepEqual(raw.state().errors, []);
          const state = await f.realtimeShutdown("status");
          assert.ok(state.upgrades.every((socket) => socket.destroyed && socket.listeners === 0), "pending query socket listeners removed");
        }
        assert.equal(f.streams().stderr, "");
      } finally {
        fault?.cancel(); raw?.dispose();
        await Promise.all(peers.map((peer) => peer.dispose()));
      }
    }
  });

import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
const admissionTree = async (root, relative = "") => {
  const tree = {};
  for (const entry of await readdir(`${root}/${relative}`, { withFileTypes: true })) {
    const name = relative + entry.name;
    if (entry.isDirectory()) { tree[name + "/"] = true; Object.assign(tree, await admissionTree(root, name + "/")); }
    else tree[name] = (await readFile(`${root}/${name}`)).toString("base64");
  }
  return tree;
};

// A completed SQL rollback with a pending JS promise cannot postpone policy close.
for (const kind of ["zero-recipient", "recipient", "audit"])
  test(`authorization rejection before rollback settlement: ${kind}`, { timeout: 20_000 }, (t) => idleFixture(t, async ({ f, a, b, other, open, sid, row, fanout, snapshot }) => {
    const receiver = kind === "recipient" ? await open("probe2") : null;
    const c = await open("arrival", other), d = await open("arrival", other);
    await writeFile(`${f.directory}/byte-sentinel.bin`, Buffer.from([0, 255, 128]));
    await mkdir(`${f.directory}/empty-sentinel`);
    const capture = async () => ({ canonical: await snapshot(), tree: await admissionTree(f.directory),
      sessions: await Promise.all(["probe", "probe2", "arrival"].map((user) => row(user))) });
    const before = await capture();
    assert.equal(before.tree["byte-sentinel.bin"], "AP+A");
    assert.equal(before.tree["empty-sentinel/"], true);
    const since = performance.now();
    await fanout(b, a, f.users.owner); // A new positive proof before arming, not just a ready frame.
    await b.dispose();
    const fault = await f.realtimeControl("arm", { mode: "rollback-delay", kind, sid: sid("probe"), actor: String(f.users.member) });
    let failure, closeTimer;
    try {
      if (kind !== "audit") a.send(sync);
      const observed = await fault.observed;
      assert.ok(observed, "positive query and same-client real ROLLBACK reached before deadline");
      assert.ok(performance.now() - since <= 2500, "marker within 2500ms of positive proof");
      const held = await f.realtimeControl("status");
      assert.deepEqual({ consumed: held.consumed, began: held.began, positive: held.positive,
        queryDone: held.queryDone, sql: held.rollbackSQLDone, rollbackDone: held.rollbackDone,
        pending: held.pending, released: held.clientReleased, early: held.earlyRelease },
      { consumed: 1, began: true, positive: true, queryDone: true, sql: true, rollbackDone: false,
        pending: 1, released: false, early: 0 });
      const doomed = [a, ...(receiver ? [receiver] : [])], closeSince = performance.now();
      try {
        await Promise.race([Promise.all(doomed.map((peer) => closed(peer, 1008, "Access denied"))),
          new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new assert.AssertionError({
            message: "policy close/end missing before explicit ROLLBACK release" })), 1500); })]);
      } finally { clearTimeout(closeTimer); doomed.forEach((peer) => peer.cancelRead()); }
      assert.ok(performance.now() - closeSince <= 1500, "close/end deadline");
      if (kind === "audit") {
        assert.deepEqual({ code: a.retirement.closeFrame?.code, reason: a.retirement.closeFrame?.reason },
          { code: 1008, reason: "Access denied" });
        assert.equal(typeof a.retirement.transportEnd, "number", "actual nonack TCP end before teardown");
      }
      assert.ok(performance.now() - since < 5000, "no 5s watchdog rescue");
      await fanout(c, d, f.users.stranger); await fanout(d, c, f.users.stranger);
      assert.deepEqual(await capture(), before);
      assert.equal(f.streams().stderr, "");
      const stillHeld = await f.realtimeControl("status");
      assert.equal(stillHeld.pending, 1); assert.equal(stillHeld.clientReleased, false);
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        await f.realtimeControl("release");
        const settled = await fault.settled;
        assert.ok(settled, "borrowed client eventually released");
        assert.deepEqual({ query: settled.queryDone, rollback: settled.rollbackDone, sql: settled.rollbackSQLDone,
          pending: settled.pending, released: settled.clientReleased, early: settled.earlyRelease },
        { query: true, rollback: true, sql: true, pending: 0, released: true, early: 0 });
        await unlink(`${f.directory}/byte-sentinel.bin`);
        await rmdir(`${f.directory}/empty-sentinel`);
      } catch (cleanupError) { if (!failure) throw cleanupError; failure.cause ??= cleanupError; }
      finally { fault.cancel(); }
    }
  }, kind !== "audit"));

// D1: SQL settlement, not route notification or a JS permission cache, fences admission.
const admissionReady = async (raw, id) => {
  const deadline = performance.now() + 1500;
  while (!raw.state().response.includes('"type":"ready"') && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(raw.state().response, /HTTP\/1\.1 101/, "D1 valid admission did not upgrade");
  assert.ok(raw.state().response.includes(JSON.stringify({ type: "ready", diagramId: id })), "D1 valid admission missing exact ready");
};
for (const operation of ["member", "diagram", "actor", "owner"])
  for (const schedule of ["stale-positive", "gate-first", "mutation-first", "beforeidentity", "failed-SQL"])
    test(`D1 admission ${operation}: ${schedule}`, { timeout: 30_000 }, async (t) => {
      const f = await persistenceFixture(t, { realtime: true });
      for (const user of ["owner", "member", "stranger"]) assert.equal((await f.request("/api/files/shared", user, "PUT", scene)).status, 200);
      const id = (await f.request("/api/diagrams", "owner")).body.diagrams[0].id;
      const other = (await f.request("/api/diagrams", "stranger")).body.diagrams[0].id;
      const route = `/api/diagrams/${id}`, target = operation === "owner" ? "owner" : "member";
      assert.equal((await f.request(`${route}/members`, "owner", "POST", { username: "member" })).status, 201);
      const snapshot = async () => ({ documents: await f.snapshot(id, "shared"),
        accounts: await f.request("/api/admin/users", "admin"), members: await f.request(`${route}/members`, "owner"), tree: await admissionTree(f.directory) });
      const before = await snapshot();
      const mutationRoute = operation === "member" ? `${route}/members/member` : operation === "diagram" ? "/api/files/shared" : `/api/admin/users/${f.users[target]}`;
      const stage = schedule === "gate-first" ? "gate" : schedule === "mutation-first" ? "before" : schedule === "beforeidentity" ? "identity" : "positive";
      const sid = decodeURIComponent(f.cookieFor("member").split("=")[1]).slice(2).split(".")[0];
      const control = (action, options = {}) => f.realtimeControl(action, { admission: true, ...options });
      const fault = await control("arm", { stage, sid, room: id, operation, target: String(f.users[target]), fail: schedule === "failed-SQL" });
      const raw = pendingRealtimeUpgrade(id, f.cookieFor("member"));
      let mutation, denial;
      try {
        const observed = await fault.observed;
        assert.ok(observed, stage === "gate" ? "D1 missing authoritative SHARE admission gate" : "D1 selected admission SQL barrier missing");
        assert.deepEqual({ hits: observed.admissionHits, ready: observed.ready }, { hits: 1, ready: 0 }, "D1 one-shot admission proof must precede ready");
        if (stage !== "before") assert.equal(observed.positive, true, "D1 consumed a real positive SQL result");
        // A distinct authenticated pending join progresses while only the selected SID/room is held.
        const unrelated = await realtimeResult(other, { cookie: f.cookieFor("stranger") });
        assert.equal(unrelated.status, 101); assert.deepEqual(JSON.parse(unrelated.body), { type: "ready", diagramId: other });
        mutation = f.request(mutationRoute, operation === "member" || operation === "diagram" ? "owner" : "admin", "DELETE");
        if (stage === "gate") {
          await f.blocked(1); // Actual PG lock wait, not absence of HTTP completion.
          await control("release", { stage: "admission" });
          await admissionReady(raw, id);
        }
        const committed = await fault.mutation;
        assert.ok(committed, "D1 selected mutation SQL did not settle");
        assert.equal(committed.mutationHits, 1);
        if (schedule === "failed-SQL") {
          const result = await mutation;
          assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "Se produjo un error interno en el servidor." });
          assert.deepEqual(await snapshot(), before);
          await control("release", { stage: "admission" });
          await admissionReady(raw, id);
          const a = realtimePeer(id, f.cookieFor("member")), b = realtimePeer(id, f.cookieFor("owner"));
          try { await a.next(); await b.next(); await relay(a, b, f.users.member); await relay(b, a, f.users.owner); }
          finally { await Promise.all([a.dispose(), b.dispose()]); }
          const status = await control("status");
          assert.equal(f.streams().stderr, status.expectedError, "D1 only exact injected DELETE error logged");
          assert.deepEqual(await snapshot(), before);
        } else {
          assert.equal(committed.mutationSettled, 1, "D1 actual canonical DELETE row settled before route delivery");
          assert.deepEqual(await admissionTree(f.directory), before.tree, "D1 no filesystem cleanup before SQL result delivery");
          const access = await f.request(route, "member");
          assert.equal(access.status, 404); assert.deepEqual(access.body, { error: "El diagrama solicitado no existe." });
          const accounts = await f.request("/api/admin/users", "admin");
          assert.equal(accounts.status, 200);
          assert.deepEqual(accounts.body, { users: before.accounts.body.users.filter((user) =>
            !["actor", "owner"].includes(operation) || user.username !== target).map((user) =>
            operation === "diagram" && user.username === "owner" ? { ...user, diagramCount: user.diagramCount - 1 } : user) });
          const ownerAccess = await f.request(route, "owner");
          assert.deepEqual({ status: ownerAccess.status, body: ownerAccess.body, etag: ownerAccess.etag },
            ["member", "actor"].includes(operation) ? before.documents[`owner:${route}`] :
              { status: 404, body: access.body, etag: access.etag });
          if (["member", "actor"].includes(operation)) assert.deepEqual((await f.request(`${route}/members`, "owner")).body, { members: [] });
          if (stage !== "gate") {
            await control("release", { stage: "admission" });
            denial = await raw.waitEnd().then(() => null, (error) => error);
          }
          await control("release", { stage: "mutation" });
          const result = await mutation;
          assert.equal(result.status, 200);
          assert.deepEqual(result.body, operation === "member" ? { ok: true } : operation === "diagram" ?
            { ok: true, file: { name: "shared", fileName: "shared.excalidraw.json" } } :
            { ok: true, user: { id: String(f.users[target]), username: target } });
          const removed = operation === "member" ? null : f.backups.relative(operation === "diagram" ? "owner" : target, operation === "diagram" ? "shared" : undefined);
          const expectedTree = Object.fromEntries(Object.entries(before.tree).filter(([name]) => !removed || (name !== removed && !name.startsWith(removed + "/"))));
          assert.deepEqual(await admissionTree(f.directory), expectedTree, "D1 exact backup bytes and directory effects");
          assert.equal(f.streams().stderr, "");
          if (stage !== "gate") {
            assert.doesNotMatch(raw.state().response, /HTTP\/1\.1 101|"type":"ready"/, "D1 no late101-ready after canonical DELETE");
            assert.equal(denial, null, "D1 denied admission transport must end after release");
            assert.match(raw.state().response, operation === "actor" ? /HTTP\/1\.1 401/ : /HTTP\/1\.1 404/);
          }
        }
      } finally {
        await control("release"); // Disarm and release BOTH holds before awaiting SQL or destroying sockets.
        try {
          if (mutation) await mutation;
          const settled = await fault.settled;
          assert.ok(settled, "D1 all selected SQL and borrowed clients settled before teardown");
          assert.equal(settled.earlyRelease, 0);
          if (settled.admissionHits) assert.equal(settled.queryDone, true);
          if (stage === "gate" && settled.clientReleased) assert.equal(settled.rollbackAfterReady, true, "D1 ready enqueued before ROLLBACK released SHARE locks");
          assert.deepEqual(raw.state().errors, []);
        } finally { fault.cancel(); raw.dispose(); }
      }
    });
