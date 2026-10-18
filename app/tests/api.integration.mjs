import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import pg from "pg";
import { backupPaths } from "./helpers/backup-paths.mjs";

// Run only via the disposable Docker runner, not against a developer's database.
assert.equal(process.env.API_TEST_ISOLATED, "1", "Use npm run test:api");
const schema = "api_test";
const base = "http://127.0.0.1:3031";
const scene = {
  type: "excalidraw", version: 2, elements: [],
  appState: { viewBackgroundColor: "#ffffff" }, files: {},
};

const request = async (route, { cookie, body, headers = {}, ...options } = {}) => {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json(),
    etag: response.headers.get("etag"),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
};
const expectResponse = (response, status, body) => {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, body);
};
const login = async (username) => {
  const result = await request("/api/auth/login", {
    method: "POST", body: { username, password: "fixture-password" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.user.username, username);
  assert.equal(result.body.user.isAdmin, username === "admin");
  assert.ok(result.cookie?.startsWith("excalidraw.sid="));
  return result.cookie;
};

// One server/database per file. Subtests run sequentially and use only HTTP for assertions.
test("authentication and private diagram storage baseline", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-api-"));
  const pool = new pg.Pool();
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env, PORT: "3031", DATA_DIR: directory, PGSCHEMA: schema,
      PGSSL: "false", SESSION_SECRET: "isolated-api-fixture-secret",
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

  // Fixture provisioning is the only direct database access in the test.
  const hash = await bcrypt.hash("fixture-password", 4);
  const users = {};
  for (const username of ["admin", "alice", "bob"]) {
    users[username] = (await pool.query(`INSERT INTO ${schema}.users (username, password_hash)
      VALUES ($1, $2) RETURNING id, username`, [username, hash])).rows[0];
  }
  const backups = backupPaths(directory, users);

  await t.test("anonymous requests do not authenticate or create backups", async () => {
    expectResponse(await request("/api/auth/session"), 200, { authenticated: false });
    for (const [route, method, body] of [
      ["/api/files", "GET"], ["/api/files/private", "GET"],
      ["/api/files/private", "PUT", scene], ["/api/files/private", "DELETE"],
    ]) {
      expectResponse(await request(route, { method, body }), 401, { error: "Necesitas iniciar sesion." });
    }
    assert.deepEqual(await readdir(directory), []);
  });

  await t.test("missing and incorrect credentials leave the session anonymous", async () => {
    expectResponse(await request("/api/auth/login", { method: "POST", body: {} }), 400,
      { error: "Debes indicar usuario y password." });
    expectResponse(await request("/api/auth/login", {
      method: "POST", body: { username: "alice", password: "incorrect" },
    }), 401, { error: "Credenciales no validas." });
    expectResponse(await request("/api/auth/session"), 200, { authenticated: false });
  });

  const alice = await login("alice");
  const bob = await login("bob");
  await t.test("login and logout establish and invalidate the session", async () => {
    const cookie = await login("admin");
    const session = await request("/api/auth/session", { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.isAdmin, true);
    expectResponse(await request("/api/auth/logout", { method: "POST", cookie }), 200, { ok: true });
    expectResponse(await request("/api/auth/session", { cookie }), 200, { authenticated: false });
    expectResponse(await request("/api/files", { cookie }), 401, { error: "Necesitas iniciar sesion." });
  });

  await t.test("save, list, load and overwrite preserve the complete scene and backup", async () => {
    expectResponse(await request("/api/files", { cookie: alice }), 200, { files: [] });
    const saved = await request("/api/files/Private Diagram", { method: "PUT", cookie: alice, body: scene });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true);
    assert.equal(saved.body.file.name, "private-diagram");
    assert.equal(saved.body.file.fileName, "private-diagram.excalidraw.json");
    assert.ok(Number.isFinite(Date.parse(saved.body.file.updatedAt)));
    const listed = await request("/api/files", { cookie: alice });
    expectResponse(listed, 200, { files: [saved.body.file] });
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 200,
      { file: saved.body.file, scene });
    const updated = { ...scene, elements: [{ id: "first", type: "rectangle", isDeleted: true }], files: { image: { id: "image", dataURL: "data:image/png;base64,AA==" } } };
    const overwritten = await request("/api/files/private-diagram", { method: "PUT", cookie: alice, body: updated, headers: { "If-Match": saved.etag } });
    assert.equal(overwritten.status, 200);
    assert.equal(overwritten.body.ok, true);
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 200,
      { file: overwritten.body.file, scene: updated });
    expectResponse(await request("/api/files", { cookie: alice }), 200, { files: [overwritten.body.file] });
    assert.deepEqual(JSON.parse(await readFile(backups.file("alice", "private-diagram"), "utf8")), updated);
  });

  await t.test("private diagrams are invisible and cannot be deleted by another user", async () => {
    const before = await request("/api/files/private-diagram", { cookie: alice });
    expectResponse(await request("/api/files", { cookie: bob }), 200, { files: [] });
    for (const method of ["GET", "DELETE"]) {
      expectResponse(await request("/api/files/private-diagram", { method, cookie: bob }), 404,
        { error: "El diagrama solicitado no existe." });
    }
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 200, before.body);
    const bobSaved = await request("/api/files/private-diagram", { method: "PUT", cookie: bob, body: scene });
    assert.equal(bobSaved.status, 200);
    expectResponse(await request("/api/files/private-diagram", { cookie: bob }), 200,
      { file: bobSaved.body.file, scene });
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 200, before.body);
  });

  await t.test("invalid saves leave existing scene, timestamp, listing and backup unchanged", async () => {
    const before = await request("/api/files/private-diagram", { cookie: alice });
    const listing = await request("/api/files", { cookie: alice });
    const backupPath = backups.file("alice", "private-diagram");
    const backup = await readFile(backupPath, "utf8");
    for (const name of ["private-diagram", "new-invalid"]) {
      expectResponse(await request(`/api/files/${name}`, { method: "PUT", cookie: alice, body: { elements: "invalid" },
        headers: name === "private-diagram" ? { "If-Match": before.etag } : {} }),
        400, { error: "El contenido del diagrama no es valido." });
    }
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 200, before.body);
    expectResponse(await request("/api/files", { cookie: alice }), 200, listing.body);
    expectResponse(await request("/api/files/new-invalid", { cookie: alice }), 404,
      { error: "El diagrama solicitado no existe." });
    assert.equal(await readFile(backupPath, "utf8"), backup);
    assert.deepEqual(await readdir(backups.directory("alice")), ["private-diagram.excalidraw.json"]);
  });

  await t.test("delete removes only the owner's diagram and backup", async () => {
    const bobBefore = await request("/api/files/private-diagram", { cookie: bob });
    expectResponse(await request("/api/files/private-diagram", { method: "DELETE", cookie: alice }), 200,
      { ok: true, file: { name: "private-diagram", fileName: "private-diagram.excalidraw.json" } });
    expectResponse(await request("/api/files", { cookie: alice }), 200, { files: [] });
    expectResponse(await request("/api/files/private-diagram", { cookie: alice }), 404,
      { error: "El diagrama solicitado no existe." });
    assert.deepEqual(await readdir(backups.directory("alice")), []);
    expectResponse(await request("/api/files/private-diagram", { cookie: bob }), 200, bobBefore.body);
  });
});
