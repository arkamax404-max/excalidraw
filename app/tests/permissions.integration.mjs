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
const schema = "permissions_test";
const base = "http://127.0.0.1:3032";
const scene = { elements: [{ id: "first", isDeleted: true }], appState: {}, files: {} };
const missing = { error: "El diagrama solicitado no existe." };
const invalid = { error: "El identificador de diagrama no es valido." };
const aliceId = "9007199254740993"; // BIGINT IDs must never pass through Number.
const bobId = "200";

const request = async (route, { cookie, body, headers = {}, ...options } = {}) => {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  return {
    status: response.status, body: payload, etag: response.headers.get("etag"),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
};
const expectResponse = (result, status, body) => {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
};
const login = async (username) => {
  const result = await request("/api/auth/login", {
    method: "POST", body: { username, password: "fixture-password" },
  });
  assert.equal(result.status, 200);
  assert.ok(result.cookie);
  return result.cookie;
};

// A distinct schema, port and backup directory isolate this file from baseline tests.
test("stable-ID discovery and owner-only loading", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-permissions-"));
  const pool = new pg.Pool();
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env, PORT: "3032", DATA_DIR: directory, PGSCHEMA: schema,
      PGSSL: "false", SESSION_SECRET: "isolated-permissions-fixture-secret",
      OPENROUTER_API_KEY: "", GROQ_API_KEY: "",
    },
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
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, output);
    if (output.includes("Excalidraw auth server listening")) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Server startup failed: ${output}`);

  // Direct SQL only provisions disposable fixtures, including an ID above MAX_SAFE_INTEGER.
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const [username, id] of [["alice", aliceId], ["bob", bobId], ["admin", null]]) {
    const user = await pool.query(`INSERT INTO ${schema}.users (username, password_hash)
      VALUES ($1, $2) RETURNING id`, [username, hash]);
    if (id) {
      await pool.query(`INSERT INTO ${schema}.diagrams (id, user_id, name, scene_json)
        VALUES ($1, $2, 'same-name', $3::jsonb)`, [id, user.rows[0].id, JSON.stringify(scene)]);
    }
  }
  const alice = await login("alice");
  const bob = await login("bob");
  const admin = await login("admin");
  const save = (cookie, body = scene, token) => request("/api/files/Same Name", {
    method: "PUT", cookie, body, headers: token ? { "If-Match": token } : {},
  });
  const aliceLoaded = await request(`/api/diagrams/${aliceId}`, { cookie: alice });
  const bobLoaded = await request(`/api/diagrams/${bobId}`, { cookie: bob });
  const aliceSaved = await save(alice, scene, aliceLoaded.etag);
  const bobSaved = await save(bob, scene, bobLoaded.etag);
  assert.equal(aliceSaved.status, 200);
  assert.equal(bobSaved.status, 200);
  let aliceFile = aliceSaved.body.file;
  const bobFile = bobSaved.body.file;
  let aliceRevision = "2";
  const document = (id, file, revision = id === aliceId ? aliceRevision : "2") => ({ id, revision, ...file });
  const backupPath = (username) => path.join(directory, username, "same-name.excalidraw.json");
  const aliceBackup = await readFile(backupPath("alice"), "utf8");
  const bobBackup = await readFile(backupPath("bob"), "utf8");
  const unchanged = async () => {
    for (const [cookie, file, username, backup] of [
      [alice, aliceFile, "alice", aliceBackup], [bob, bobFile, "bob", bobBackup],
    ]) {
      expectResponse(await request("/api/files", { cookie }), 200, { files: [file] });
      expectResponse(await request("/api/files/Same Name", { cookie }), 200, { file, scene });
      assert.equal(await readFile(backupPath(username), "utf8"), backup);
    }
  };

  await t.test("anonymous discovery and loads require authentication even for invalid IDs", async () => {
    for (const route of ["/api/diagrams", `/api/diagrams/${aliceId}`, "/api/diagrams/invalid"]) {
      expectResponse(await request(route), 401, { error: "Necesitas iniciar sesion." });
    }
    await unchanged();
  });

  await t.test("owners discover distinct string IDs for identical normalized names", async () => {
    for (const [cookie, id, file] of [[alice, aliceId, aliceFile], [bob, bobId, bobFile]]) {
      expectResponse(await request("/api/diagrams", { cookie }), 200, { diagrams: [document(id, file)] });
      expectResponse(await request(`/api/diagrams/${id}`, { cookie }), 200,
        { diagram: document(id, file), scene });
    }
    expectResponse(await request("/api/diagrams", { cookie: admin }), 200, { diagrams: [] });
    await unchanged();
  });

  await t.test("nonowners and admin cannot distinguish private from missing IDs", async () => {
    for (const [cookie, ids] of [[bob, [aliceId]], [alice, [bobId]], [admin, [aliceId, bobId]]]) {
      for (const id of [...ids, "9223372036854775807"]) {
        expectResponse(await request(`/api/diagrams/${id}`, { cookie }), 404, missing);
      }
    }
    await unchanged();
  });

  await t.test("malformed IDs are rejected without coercion or effects", async () => {
    for (const id of ["0", "-1", "01", "1.0", "1e0", "+1", "abc", "%20", "1%20", "９", "9223372036854775808", "9".repeat(100)]) {
      expectResponse(await request(`/api/diagrams/${id}`, { cookie: alice }), 400, invalid);
    }
    await unchanged();
    expectResponse(await request("/api/diagrams", { cookie: alice }), 200,
      { diagrams: [document(aliceId, aliceFile)] });
  });

  await t.test("legacy overwrite preserves ID, full scene and exact legacy response shape", async () => {
    const updatedScene = { ...scene, files: { image: { id: "image", dataURL: "data:image/png;base64,AA==" } } };
    const saved = await save(alice, updatedScene, aliceSaved.etag);
    assert.equal(saved.status, 200);
    aliceFile = saved.body.file;
    aliceRevision = "3";
    assert.deepEqual(Object.keys(saved.body).sort(), ["file", "ok"]);
    assert.equal(saved.body.ok, true);
    assert.deepEqual(Object.keys(aliceFile).sort(), ["fileName", "name", "updatedAt"]);
    assert.equal(aliceFile.name, "same-name");
    assert.equal(aliceFile.fileName, "same-name.excalidraw.json");
    assert.ok(Number.isFinite(Date.parse(aliceFile.updatedAt)));
    expectResponse(await request("/api/files/same-name", { cookie: alice }), 200,
      { file: aliceFile, scene: updatedScene });
    expectResponse(await request("/api/diagrams", { cookie: alice }), 200,
      { diagrams: [document(aliceId, aliceFile)] });
    expectResponse(await request(`/api/diagrams/${aliceId}`, { cookie: alice }), 200,
      { diagram: document(aliceId, aliceFile), scene: updatedScene });
    assert.deepEqual(JSON.parse(await readFile(backupPath("alice"), "utf8")), updatedScene);
    expectResponse(await request(`/api/diagrams/${bobId}`, { cookie: bob }), 200,
      { diagram: document(bobId, bobFile), scene });
    assert.equal(await readFile(backupPath("bob"), "utf8"), bobBackup);
  });

  await t.test("discovery orders multiple owner documents without exposing them to others", async () => {
    const saved = await request("/api/files/newer", { cookie: alice, method: "PUT", body: scene });
    assert.equal(saved.status, 200);
    const listed = await request("/api/diagrams", { cookie: alice });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.diagrams.length, 2);
    const newerId = listed.body.diagrams[0].id;
    assert.match(newerId, /^[1-9][0-9]*$/);
    expectResponse(listed, 200, { diagrams: [document(newerId, saved.body.file, "1"), document(aliceId, aliceFile)] });
    expectResponse(await request("/api/diagrams", { cookie: bob }), 200,
      { diagrams: [document(bobId, bobFile)] });
    expectResponse(await request("/api/diagrams", { cookie: admin }), 200, { diagrams: [] });
    expectResponse(await request(`/api/diagrams/${newerId}`, { cookie: bob }), 404, missing);
    expectResponse(await request("/api/files/newer", { cookie: alice, method: "DELETE" }), 200,
      { ok: true, file: { name: "newer", fileName: "newer.excalidraw.json" } });
  });

  await t.test("legacy delete removes the ID; recreating the same name gets a new ID", async () => {
    expectResponse(await request("/api/files/Same Name", { cookie: alice, method: "DELETE" }), 200,
      { ok: true, file: { name: "same-name", fileName: "same-name.excalidraw.json" } });
    expectResponse(await request("/api/diagrams", { cookie: alice }), 200, { diagrams: [] });
    expectResponse(await request(`/api/diagrams/${aliceId}`, { cookie: alice }), 404, missing);
    expectResponse(await request("/api/files/same-name", { cookie: alice }), 404, missing);
    await assert.rejects(readFile(backupPath("alice")), { code: "ENOENT" });
    const saved = await save(alice);
    assert.equal(saved.status, 200);
    const listed = await request("/api/diagrams", { cookie: alice });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.diagrams.length, 1);
    const id = listed.body.diagrams[0].id;
    assert.match(id, /^[1-9][0-9]*$/);
    assert.notEqual(id, aliceId);
    expectResponse(listed, 200, { diagrams: [document(id, saved.body.file, "1")] });
    expectResponse(await request(`/api/diagrams/${id}`, { cookie: alice }), 200,
      { diagram: document(id, saved.body.file, "1"), scene });
    expectResponse(await request(`/api/diagrams/${bobId}`, { cookie: bob }), 200,
      { diagram: document(bobId, bobFile), scene });
    assert.equal(await readFile(backupPath("bob"), "utf8"), bobBackup);
  });
});
