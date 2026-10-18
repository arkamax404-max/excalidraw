import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import pg from "pg";

assert.equal(process.env.API_TEST_ISOLATED, "1", "Use npm run test:api");
const schema = "revision_test";
const base = "http://127.0.0.1:3034";
const id = "9007199254740993";
const maximum = "9223372036854775807";
const timestamp = "2020-01-02T03:04:05.000Z";
const scene = { elements: [{ id: "deleted", isDeleted: true }],
  appState: { scrollX: 12 }, files: { image: { dataURL: "data:image/png;base64,AA==" } } };
const missing = { error: "El diagrama solicitado no existe." };
const request = async (route, cookie, method = "GET", body, headers = {}) => {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(),
    etag: response.headers.get("etag"), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};
const expect = (result, status, body) => {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
};

test("public revision foundation and additive migrations", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-revisions-"));
  const pool = new pg.Pool();
  let server;
  let closed;
  const stop = async () => { server.kill("SIGTERM"); await closed; };
  t.after(async () => {
    if (server?.exitCode === null) await stop();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  // Pre-revision schema and old data: SQL is fixture setup, never a behavior assertion.
  const oldSchemaSQL = `CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.users (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, display_name TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE ${schema}.diagrams (id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, scene_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT diagrams_user_name_unique UNIQUE (user_id, name));`;
  await pool.query(oldSchemaSQL);
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const username of ["owner", "member", "stranger", "admin"]) {
    await pool.query(`INSERT INTO ${schema}.users (username, password_hash) VALUES ($1, $2)`, [username, hash]);
  }
  await pool.query(`INSERT INTO ${schema}.diagrams (id, user_id, name, scene_json, created_at, updated_at)
    VALUES ($1, 1, 'old', $2, $3, $3)`, [id, JSON.stringify(scene), timestamp]);
  const start = async (schemaName = schema) => {
    let output = "";
    server = spawn(process.execPath, ["server.mjs"], {
      env: { ...process.env, PORT: "3034", PGSCHEMA: schemaName, DATA_DIR: directory,
        PGSSL: "false", SESSION_SECRET: "isolated-revisions-secret", OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = once(server, "close");
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100 && !output.includes("Excalidraw auth server listening"); attempt++) {
      assert.equal(server.exitCode, null, output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /Excalidraw auth server listening/);
  };
  await start();
  const cookies = {};
  for (const username of ["owner", "member", "stranger", "admin"]) {
    const result = await request("/api/auth/login", null, "POST", { username, password: "fixture-password" });
    assert.equal(result.status, 200);
    cookies[username] = result.cookie;
  }
  const route = `/api/diagrams/${id}`;
  const legacy = "/api/files/old";
  const file = { name: "old", fileName: "old.excalidraw.json", updatedAt: timestamp };
  await t.test("startup preserves old scene, identity and timestamp with default revision one", async () => {
    expect(await request(route, cookies.owner), 200, { diagram: { id, revision: "1", ...file }, scene });
    expect(await request(legacy, cookies.owner), 200, { file, scene });
    assert.equal((await request(route, cookies.owner)).etag, `"${id}:1"`);
  });
  await t.test("standalone migration and startup reapply without rewriting old data", async () => {
    const sql = (await readFile("../db/003_diagram_revisions.sql", "utf8")).replaceAll("excalidraw", schema);
    await pool.query(sql);
    await pool.query(sql);
    const standalone = `${schema}_sql`;
    await pool.query(oldSchemaSQL.replaceAll(schema, standalone));
    await pool.query(`INSERT INTO ${standalone}.users (username, password_hash) VALUES ('owner', $1)`, [hash]);
    await pool.query(`INSERT INTO ${standalone}.diagrams (id, user_id, name, scene_json, updated_at)
      VALUES ($1, 1, 'old', $2, $3)`, [id, JSON.stringify(scene), timestamp]);
    for (let attempt = 0; attempt < 2; attempt++) {
      await pool.query(sql.replaceAll(schema, standalone));
      const init = (await readFile("../db/001_init.sql", "utf8")).replaceAll("excalidraw", standalone);
      await pool.query(init);
    }
    await stop();
    await start(standalone);
    const logged = await request("/api/auth/login", null, "POST", { username: "owner", password: "fixture-password" });
    expect(await request(route, logged.cookie), 200, { diagram: { id, revision: "1", ...file }, scene });
    await stop();
    await start();
    expect(await request(route, cookies.owner), 200, { diagram: { id, revision: "1", ...file }, scene });
  });
  await request(`${route}/members`, cookies.owner, "POST", { username: "member" });
  await t.test("owner and active member get the same strong token; private errors stay exact", async () => {
    for (const cookie of [cookies.owner, cookies.member]) {
      const loaded = await request(route, cookie);
      assert.equal(loaded.etag, `"${id}:1"`);
      assert.equal(loaded.body.diagram.revision, "1");
      const listed = await request("/api/diagrams", cookie);
      assert.deepEqual(listed.body.diagrams, [loaded.body.diagram]);
    }
    assert.equal((await request(legacy, cookies.owner)).etag, `"${id}:1"`);
    expect(await request(route), 401, { error: "Necesitas iniciar sesion." });
    for (const username of ["stranger", "admin"]) {
      expect(await request(route, cookies[username]), 404, missing);
      expect(await request("/api/diagrams/9223372036854775807", cookies[username]), 404, missing);
      expect(await request(legacy, cookies[username]), 404, missing);
    }
  });
  await t.test("revocation removes version access immediately without advancing the owner's revision", async () => {
    const before = await request(route, cookies.owner);
    expect(await request(`${route}/members/member`, cookies.owner, "DELETE"), 200, { ok: true });
    const revoked = await request(route, cookies.member);
    expect(revoked, 404, missing);
    assert.notEqual(revoked.etag, before.etag);
    expect(await request("/api/diagrams", cookies.member), 200, { diagrams: [] });
    assert.deepEqual(await request(route, cookies.owner), before);
    const restored = await request(`${route}/members`, cookies.owner, "POST", { username: "member" });
    assert.equal(restored.status, 201);
    const loaded = await request(route, cookies.member);
    assert.equal(loaded.etag, before.etag);
    assert.deepEqual(loaded.body, before.body);
  });
  const backup = path.join(directory, "owner", "old.excalidraw.json");
  await t.test("legacy normalized overwrite increments once, retains ID, raw scene and JSON shape", async () => {
    const prior = await request(route, cookies.owner);
    const saved = await request("/api/files/Old!!", cookies.owner, "PUT", scene, { "If-Match": prior.etag });
    assert.equal(saved.status, 200);
    assert.equal(saved.etag, `"${id}:2"`);
    assert.deepEqual(Object.keys(saved.body).sort(), ["file", "ok"]);
    assert.deepEqual(Object.keys(saved.body.file).sort(), ["fileName", "name", "updatedAt"]);
    const loaded = await request(route, cookies.member);
    expect(loaded, 200, { diagram: { id, revision: "2", ...saved.body.file }, scene });
    expect(await request(legacy, cookies.owner), 200, { file: saved.body.file, scene });
    expect(await request("/api/files", cookies.owner), 200, { files: [saved.body.file] });
    assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), scene);
    const before = await request(route, cookies.owner);
    const bytes = await readFile(backup, "utf8");
    expect(await request(legacy, cookies.owner, "PUT", { elements: "invalid" }, { "If-Match": before.etag }), 400,
      { error: "El contenido del diagrama no es valido." });
    assert.deepEqual(await request(route, cookies.owner), before);
    assert.equal(await readFile(backup, "utf8"), bytes);
  });
  // Boundary fixtures include a backup, so rejection must preserve bytes, not just absence.
  await pool.query(`ALTER TABLE ${schema}.diagrams ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1`);
  for (const [name, revision, fixtureId] of [["precise", "9007199254740993", "9007199254740994"],
    ["overflow", maximum, maximum], ["last", "9223372036854775806", "9007199254740995"]]) {
    await pool.query(`INSERT INTO ${schema}.diagrams (id, user_id, name, scene_json, revision, updated_at)
      VALUES ($1, 1, $2, $3, $4, $5)`, [fixtureId, name, JSON.stringify(scene), revision, timestamp]);
    await mkdir(path.join(directory, "owner"), { recursive: true });
    await writeFile(path.join(directory, "owner", `${name}.excalidraw.json`), `${JSON.stringify(scene)}\n`);
  }
  await t.test("revisions above safe integer stay exact through reads and SQL increments", async () => {
    const prior = await request("/api/files/precise", cookies.owner);
    const saved = await request("/api/files/precise", cookies.owner, "PUT", scene, { "If-Match": prior.etag });
    assert.equal(saved.etag, '"9007199254740994:9007199254740994"');
    const loaded = await request("/api/diagrams/9007199254740994", cookies.owner);
    assert.equal(loaded.body.diagram.revision, "9007199254740994");
    assert.equal(loaded.etag, saved.etag);
  });
  await t.test("BIGINT overflow rejects without changing scene, revision, timestamp or backup", async () => {
    const url = `/api/diagrams/${maximum}`;
    const before = await request(url, cookies.owner);
    const boundaryBackup = path.join(directory, "owner", "overflow.excalidraw.json");
    const bytes = await readFile(boundaryBackup, "utf8");
    expect(await request("/api/files/overflow", cookies.owner, "PUT", { elements: [] }, { "If-Match": before.etag }), 409,
      { error: "El diagrama ha alcanzado el limite de revisiones." });
    assert.equal(before.etag, `"${maximum}:${maximum}"`);
    assert.equal(before.body.diagram.revision, maximum);
    assert.deepEqual(await request(url, cookies.owner), before);
    assert.equal(await readFile(boundaryBackup, "utf8"), bytes);
  });
  await t.test("last representable increment succeeds once, then rejects invalid and overflowing scenes", async () => {
    const prior = await request("/api/files/last", cookies.owner);
    const saved = await request("/api/files/last", cookies.owner, "PUT", scene, { "If-Match": prior.etag });
    assert.equal(saved.status, 200);
    assert.equal(saved.etag, `"9007199254740995:${maximum}"`);
    const url = "/api/diagrams/9007199254740995";
    const before = await request(url, cookies.owner);
    const boundaryBackup = path.join(directory, "owner", "last.excalidraw.json");
    const bytes = await readFile(boundaryBackup, "utf8");
    expect(await request("/api/files/last", cookies.owner, "PUT", {}, { "If-Match": before.etag }), 400,
      { error: "El contenido del diagrama no es valido." });
    expect(await request("/api/files/last", cookies.owner, "PUT", { elements: [] }, { "If-Match": before.etag }), 409,
      { error: "El diagrama ha alcanzado el limite de revisiones." });
    assert.deepEqual(await request(url, cookies.owner), before);
    assert.equal(await readFile(boundaryBackup, "utf8"), bytes);
    await stop();
    await start();
    assert.deepEqual(await request(url, cookies.owner), before);
  });
  await t.test("guarded simultaneous replacements allow only one matching revision",  async () => {
    const url = "/api/files/concurrent";
    const created = await request(url, cookies.owner, "PUT", scene);
    assert.equal(created.status, 200);
    const pair = await Promise.all([request(url, cookies.owner, "PUT", scene, { "If-Match": created.etag }),
      request(url, cookies.owner, "PUT", scene, { "If-Match": created.etag })]);
    assert.deepEqual(pair.map((result) => result.status).sort(), [200, 412]);
    const freshId = created.etag.split(":")[0].slice(1);
    assert.equal(pair.find((result) => result.status === 200).etag, `"${freshId}:2"`);
    const loaded = await request(`/api/diagrams/${freshId}`, cookies.owner);
    assert.equal(loaded.body.diagram.revision, "2");
    assert.deepEqual(loaded.body.scene, scene);
  });
  await t.test("delete/recreate yields a new ID and token at revision one; create starts at one", async () => {
    const before = await request(route, cookies.owner);
    assert.equal((await request(legacy, cookies.owner, "DELETE")).status, 200);
    expect(await request(route, cookies.owner), 404, missing);
    await assert.rejects(readFile(backup), { code: "ENOENT" });
    const saved = await request(legacy, cookies.owner, "PUT", scene);
    assert.equal(saved.status, 200);
    const listed = await request("/api/diagrams", cookies.owner);
    const fresh = listed.body.diagrams.find((diagram) => diagram.name === "old");
    assert.notEqual(fresh.id, id);
    assert.equal(fresh.revision, "1");
    assert.equal(saved.etag, `"${fresh.id}:1"`);
    assert.notEqual(saved.etag, before.etag);
    assert.equal((await request(`/api/diagrams/${fresh.id}`, cookies.owner)).etag, saved.etag);
    expect(await request(`/api/diagrams/${fresh.id}`, cookies.member), 404, missing);
  });
});
