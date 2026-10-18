import assert from "node:assert/strict";
import test from "node:test";
import { persistenceFixture } from "./helpers/persistence-fixture.mjs";
import { realtimeOrigin, realtimeResult } from "./helpers/realtime-client.mjs";

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
