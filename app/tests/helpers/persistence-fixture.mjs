import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import pg from "pg";
import { backupPaths } from "./backup-paths.mjs";

export const persistenceFixture = async (t, { seedData, realtime = false } = {}) => {
  assert.equal(process.env.API_TEST_ISOLATED, "1", "Use npm run test:api");
  const schema = `persistence_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(path.join(tmpdir(), "excalidraw-persistence-"));
  const pool = new pg.Pool();
  let server;
  let closed;
  t.after(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await closed;
    }
    await pool.end();
    // The isolated runner's container owns and discards this temporary directory.
  });
  if (seedData) await seedData(directory);
  let output = "";
  let stdout = "", stderr = "";
  server = spawn(process.execPath, ["--import", fileURLToPath(new URL("./storage-barrier.mjs", import.meta.url)),
    ...(realtime ? ["--import", fileURLToPath(new URL("./realtime-barrier.mjs", import.meta.url))] : []),
    fileURLToPath(new URL("../../server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: "3035", PGSCHEMA: schema, DATA_DIR: directory,
      PGSSL: "false", PGAPPNAME: schema, SESSION_SECRET: "isolated-persistence-secret",
      OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  closed = once(server, "close");
  server.stdout.on("data", (chunk) => { output += chunk; stdout += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; stderr += chunk; });
  for (let attempt = 0; attempt < 100 && !output.includes("Excalidraw auth server listening"); attempt++) {
    assert.equal(server.exitCode, null, output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /Excalidraw auth server listening/);

  const cookies = {};
  const users = {};
  const accounts = {};
  const backups = backupPaths(directory, accounts);
  const request = async (route, user, method = "GET", body, headers = {}, captureHeaders = false) => {
    const response = await fetch(`http://127.0.0.1:3035${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { Cookie: cookies[user] } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ...(captureHeaders ? { headers: Object.fromEntries(response.headers) } : {}),
      status: response.status, body: await response.json(),
      etag: response.headers.get("etag"), warning: response.headers.get("x-backup-warning"), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const username of ["owner", "member", "stranger", "admin"]) {
    users[username] = (await pool.query(`INSERT INTO ${schema}.users (username, password_hash)
      VALUES ($1, $2) RETURNING id`, [username, hash])).rows[0].id;
    const login = await request("/api/auth/login", null, "POST", { username, password: "fixture-password" });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    cookies[username] = login.cookie;
    accounts[username] = login.body.user;
  }

  const backupTree = async (relative = "") => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    const files = {};
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(files, await backupTree(name));
      else files[name] = await readFile(path.join(directory, name), "utf8");
    }
    return files;
  };
  const snapshot = async (id, name) => {
    const state = {};
    for (const user of ["owner", "member"]) {
      for (const route of [`/api/diagrams/${id}`, "/api/diagrams", "/api/files", `/api/files/${name}`]) {
        const { status, body, etag } = await request(route, user);
        state[`${user}:${route}`] = { status, body, etag };
      }
    }
    state.backups = await backupTree();
    return state;
  };
  const setup = (sql, values) => pool.query(sql.replaceAll("fixture_schema", schema), values);
  const storageBarrier = async (operation, relative, fault = false) => {
    const message = async (kind) => {
      for (;;) {
        const [event] = await once(server, "message", { signal: AbortSignal.timeout(10_000) });
        if (event.storage === kind) return;
      }
    };
    const ready = message("armed");
    server.send({ storage: "arm", operation, path: path.join(directory, relative), fault });
    await ready;
    const blocked = message("blocked");
    // Register teardown before a failed assertion can strand the child.
    const release = () => server.connected && server.send({ storage: "release" });
    t.after(release);
    return { blocked, release };
  };
  const realtimeGate = async () => {
    assert.equal(realtime, true, "Realtime preload must be explicitly enabled");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const wait = async (kind) => {
      for (;;) {
        const [event] = await once(server, "message", { signal: controller.signal });
        if (event.realtime === kind) return;
      }
    };
    const ready = wait("armed");
    server.send({ realtime: "arm" });
    const release = (pressure = false) => {
      clearTimeout(timer); controller.abort();
      if (server.connected) server.send({ realtime: "release", pressure });
    };
    t.after(() => release());
    await ready;
    const blocked = wait("blocked");
    blocked.catch(() => {}); // Teardown cancellation is always consumed.
    return { blocked, release };
  };
  const realtimeObserve = async (now = null) => {
    assert.equal(realtime, true, "Realtime preload must be explicitly enabled");
    const reply = (async () => {
      for (;;) {
        const [event] = await once(server, "message", { signal: AbortSignal.timeout(5000) });
        if (event.realtime === "observed") return event;
      }
    })();
    server.send({ realtime: "observe", now });
    return reply;
  };
  const blocked = async (count) => {
    const deadline = Date.now() + 5000;
    do {
      const result = await pool.query(`SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE application_name = $1
        AND cardinality(pg_blocking_pids(pid)) > 0`, [schema]);
      if (result.rowCount === count) {
        console.log("observed PG blocking", JSON.stringify(result.rows));
        return result.rows;
      }
    } while (Date.now() < deadline);
    assert.fail(`Expected ${count} observed blocked fixture sessions`);
  };
  const documentLock = async (name) => {
    const client = await pool.connect();
    const key = JSON.stringify([schema, users.owner, name]);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return async () => {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      client.release();
    };
  };
  const directoryLock = async () => {
    const client = await pool.connect();
    const key = JSON.stringify(["directory", backups.directory("owner")]);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return async () => {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      client.release();
    };
  };
  const loginAs = async (alias, username) => {
    const login = await request("/api/auth/login", null, "POST", { username, password: "fixture-password" });
    assert.equal(login.status, 200);
    cookies[alias] = login.cookie;
    accounts[alias] = login.body.user;
  };
  return { request, snapshot, setup, directory, users, storageBarrier, blocked, documentLock,
    directoryLock, loginAs, backups, realtimeGate, realtimeObserve,
    cookieFor: (user) => cookies[user], logs: () => output, streams: () => ({ stdout, stderr }) };
};
