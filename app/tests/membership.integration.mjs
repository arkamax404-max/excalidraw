import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import pg from "pg";

assert.equal(process.env.API_TEST_ISOLATED, "1", "Use npm run test:api");
const schema = `membership_${process.pid}`;
const base = "http://127.0.0.1:3033";
const scene = { elements: [{ id: "retained", isDeleted: true }], files: {}, appState: {} };
const missing = { error: "El diagrama solicitado no existe." };
const denied = { error: "Necesitas ser propietario del diagrama." };
const invalidId = { error: "El identificador de diagrama no es valido." };
const invalidUser = { error: "El usuario no es valido." };
const ownerError = { error: "El propietario no puede ser miembro." };
const request = async (route, cookie, method = "GET", body) => {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: response.status, body: payload, cookie: response.headers.get("set-cookie")?.split(";")[0] };
};
const expect = (result, status, body) => {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
};

test("owner-controlled membership HTTP contracts", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-membership-"));
  const pool = new pg.Pool();
  const server = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: "3033", DATA_DIR: directory, PGSCHEMA: schema,
      SESSION_SECRET: "isolated-membership-secret", PGSSL: "false", OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(server, "close");
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    server.kill("SIGTERM");
    await closed;
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100 && !output.includes("Excalidraw auth server listening"); attempt++) {
    assert.equal(server.exitCode, null, output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /Excalidraw auth server listening/);
  const cookies = {};
  const users = {};
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const username of ["owner", "member", "stranger", "admin", "inactive"]) {
    // SQL only provisions accounts and a full-range diagram ID, never asserts behavior.
    await pool.query(`INSERT INTO ${schema}.users (username, password_hash, is_active)
      VALUES ($1, $2, $3)`, [username, hash, username !== "inactive"]);
    if (username === "inactive") continue;
    const logged = await request("/api/auth/login", null, "POST", { username, password: "fixture-password" });
    assert.equal(logged.status, 200);
    cookies[username] = logged.cookie;
    users[username] = logged.body.user;
  }
  await pool.query(`INSERT INTO ${schema}.diagrams (id, user_id, name, scene_json)
    VALUES ('9007199254740993', $1, 'same-name', $2::jsonb)`, [users.owner.id, JSON.stringify(scene)]);
  for (const username of ["owner", "member"]) {
    assert.equal((await request("/api/files/Same Name", cookies[username], "PUT", scene)).status, 200);
  }
  const ownerList = (await request("/api/diagrams", cookies.owner)).body;
  const memberList = (await request("/api/diagrams", cookies.member)).body;
  const id = ownerList.diagrams[0].id;
  const route = `/api/diagrams/${id}`;
  const members = `${route}/members`;
  const member = { id: users.member.id, username: "member", displayName: "member", isAdmin: false };
  const grant = () => request(members, cookies.owner, "POST", { username: " member " });
  const revoke = () => request(`${members}/member`, cookies.owner, "DELETE");
  const snapshot = async () => ({
    memberships: (await request(members, cookies.owner)).body,
    owner: await request(route, cookies.owner),
    lists: await Promise.all(["owner", "member", "stranger", "admin"].map(async (name) =>
      (await request("/api/diagrams", cookies[name])).body)),
    legacy: await Promise.all(["owner", "member"].map(async (name) => ({
      list: (await request("/api/files", cookies[name])).body,
      load: (await request("/api/files/same-name", cookies[name])).body,
      backup: await readFile(path.join(directory, name, "same-name.excalidraw.json"), "utf8"),
    }))),
  });
  const rejected = async (url, cookie, method, body, status, payload) => {
    const before = await snapshot();
    expect(await request(url, cookie, method, body), status, payload);
    assert.deepEqual(await snapshot(), before);
  };

  await t.test("owner lists, grants normalized registered member, and preserves document metadata", async () => {
    expect(await request(members, cookies.owner), 200, { members: [] });
    const before = await snapshot();
    expect(await grant(), 201, { ok: true, member });
    expect(await request(members, cookies.owner), 200, { members: [member] });
    const after = await snapshot();
    assert.deepEqual(after.owner, before.owner);
    assert.deepEqual(after.legacy, before.legacy);
  });
  await t.test("member discovers and loads shared ID without same-name collision or legacy shared access", async () => {
    const loaded = await request(route, cookies.owner);
    expect(await request(route, cookies.member), 200, loaded.body);
    expect(await request("/api/diagrams", cookies.member), 200,
      { diagrams: [...memberList.diagrams, ...ownerList.diagrams] });
    expect(await request("/api/files", cookies.member), 200,
      { files: memberList.diagrams.map(({ id: _id, ...file }) => file) });
  });
  await t.test("nonmembers cannot discover or load and admin has no ownership bypass", async () => {
    for (const name of ["stranger", "admin"]) {
      expect(await request("/api/diagrams", cookies[name]), 200, { diagrams: [] });
      expect(await request(route, cookies[name]), 404, missing);
      for (const method of ["GET", "POST", "DELETE"]) {
        await rejected(method === "DELETE" ? `${members}/member` : members,
          cookies[name], method, { username: "stranger" }, 403, denied);
      }
    }
  });
  await t.test("members cannot list, add, revoke others, revoke self, or self-elevate", async () => {
    for (const [url, method, body] of [[members, "GET"], [members, "POST", { username: "stranger" }],
      [members, "POST", { username: "member", role: "owner" }],
      [`${members}/stranger`, "DELETE"], [`${members}/member`, "DELETE"]]) {
      await rejected(url, cookies.member, method, body, 403, denied);
    }
  });
  await t.test("duplicates and owner membership mutations are explicit and effect-free", async () => {
    await rejected(members, cookies.owner, "POST", { username: "member" }, 409,
      { error: "Ese usuario ya es miembro." });
    await rejected(members, cookies.owner, "POST", { username: "owner" }, 400, ownerError);
    await rejected(`${members}/owner`, cookies.owner, "DELETE", undefined, 400, ownerError);
  });
  await t.test("inactive and nonexistent accounts never receive grants", async () => {
    for (const username of ["inactive", "absent"]) {
      await rejected(members, cookies.owner, "POST", { username }, 404,
        { error: "El usuario activo solicitado no existe." });
      await rejected(`${members}/${username}`, cookies.owner, "DELETE", undefined, 404,
        { error: "La membresia solicitada no existe." });
    }
  });
  await t.test("invalid member inputs and canonical BIGINT boundaries do not mutate", async () => {
    for (const username of [undefined, null, {}, [], 123, "", "ab", "bad user", "a".repeat(51), "ｍember"]) {
      await rejected(members, cookies.owner, "POST", { username }, 400, invalidUser);
    }
    for (const username of ["ab", "bad%20user", "a".repeat(51)]) {
      await rejected(`${members}/${username}`, cookies.owner, "DELETE", undefined, 400, invalidUser);
    }
    for (const bad of ["0", "01", "-1", "1e0", "%20", "9223372036854775808"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        await rejected(`/api/diagrams/${bad}/members${method === "DELETE" ? "/member" : ""}`,
          cookies.owner, method, { username: "member" }, 400, invalidId);
      }
    }
    for (const method of ["GET", "POST", "DELETE"]) {
      await rejected(`/api/diagrams/9223372036854775807/members${method === "DELETE" ? "/member" : ""}`,
        cookies.owner, method, { username: "member" }, 404, missing);
    }
  });
  await t.test("authentication precedes diagram and member input validation", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      await rejected(`/api/diagrams/invalid/members${method === "DELETE" ? "/ab" : ""}`,
        null, method, {}, 401, { error: "Necesitas iniciar sesion." });
    }
  });
  await t.test("revocation removes list/load access on next HTTP request but never owner access", async () => {
    expect(await revoke(), 200, { ok: true });
    expect(await request(members, cookies.owner), 200, { members: [] });
    expect(await request(route, cookies.member), 404, missing);
    expect(await request("/api/diagrams", cookies.member), 200, memberList);
    expect(await request("/api/diagrams", cookies.owner), 200, ownerList);
    await rejected(`${members}/member`, cookies.owner, "DELETE", undefined, 404,
      { error: "La membresia solicitada no existe." });
  });
  await t.test("deleting a member account cascades membership but retains owner's diagram", async () => {
    expect(await grant(), 201, { ok: true, member });
    expect(await request(`/api/admin/users/${users.member.id}`, cookies.admin, "DELETE"), 200,
      { ok: true, user: { id: users.member.id, username: "member" } });
    expect(await request(members, cookies.owner), 200, { members: [] });
    expect(await request("/api/diagrams", cookies.owner), 200, ownerList);
    expect(await request(route, cookies.member), 404, missing);
    assert.deepEqual((await request(route, cookies.owner)).body.scene, scene);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "owner", "same-name.excalidraw.json"))), scene);
  });
  await t.test("diagram deletion cascades memberships; recreation does not inherit grants", async () => {
    const stranger = { ...users.stranger };
    expect(await request(members, cookies.owner, "POST", { username: "stranger" }), 201,
      { ok: true, member: stranger });
    assert.equal((await request("/api/files/same-name", cookies.owner, "DELETE")).status, 200);
    expect(await request(`${route}/members`, cookies.owner), 404, missing);
    expect(await request("/api/diagrams", cookies.stranger), 200, { diagrams: [] });
    assert.equal((await request("/api/files/same-name", cookies.owner, "PUT", scene)).status, 200);
    const fresh = (await request("/api/diagrams", cookies.owner)).body.diagrams[0].id;
    assert.notEqual(fresh, id);
    expect(await request(`/api/diagrams/${fresh}/members`, cookies.owner), 200, { members: [] });
  });
  await t.test("owner account deletion deletes shared diagrams and backup, not member accounts", async () => {
    const fresh = (await request("/api/diagrams", cookies.owner)).body.diagrams[0].id;
    assert.equal((await request(`/api/diagrams/${fresh}/members`, cookies.owner, "POST", { username: "stranger" })).status, 201);
    expect(await request(`/api/admin/users/${users.owner.id}`, cookies.admin, "DELETE"), 200,
      { ok: true, user: { id: users.owner.id, username: "owner" } });
    expect(await request(`/api/diagrams/${fresh}`, cookies.stranger), 404, missing);
    expect(await request("/api/diagrams", cookies.stranger), 200, { diagrams: [] });
    await assert.rejects(readFile(path.join(directory, "owner", "same-name.excalidraw.json")), { code: "ENOENT" });
    const accounts = await request("/api/admin/users", cookies.admin);
    assert.equal(accounts.status, 200);
    assert.ok(accounts.body.users.some((user) => user.username === "stranger"));
  });
});
