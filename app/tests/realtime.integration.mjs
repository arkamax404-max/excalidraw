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
    } else if (recipient) a.send(sync);
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
