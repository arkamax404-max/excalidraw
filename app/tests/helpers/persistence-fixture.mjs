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

export const persistenceFixture = async (t) => {
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
  let output = "";
  server = spawn(process.execPath, [fileURLToPath(new URL("../../server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: "3035", PGSCHEMA: schema, DATA_DIR: directory,
      PGSSL: "false", SESSION_SECRET: "isolated-persistence-secret",
      OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
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

  const cookies = {};
  const request = async (route, user, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:3035${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { Cookie: cookies[user] } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(),
      etag: response.headers.get("etag"), warning: response.headers.get("x-backup-warning"), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const hash = await bcrypt.hash("fixture-password", 4);
  for (const username of ["owner", "member", "stranger", "admin"]) {
    await pool.query(`INSERT INTO ${schema}.users (username, password_hash) VALUES ($1, $2)`, [username, hash]);
    const login = await request("/api/auth/login", null, "POST", { username, password: "fixture-password" });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    cookies[username] = login.cookie;
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
  return { request, snapshot, setup, directory, logs: () => output };
};
