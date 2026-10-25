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
import { persistenceFixture } from "./helpers/persistence-fixture.mjs";
import { realtimePeer } from "./helpers/realtime-peer.mjs";

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

for (const cleanupFails of [false, true]) {
  test(cleanupFails
    ? "owner DELETE retires diagram transports before failing backup cleanup"
    : "owner DELETE promptly retires only the deleted diagram's transports", { timeout: 60_000 }, async (t) => {
    const f = await persistenceFixture(t);
    const rooms = [];
    for (const name of ["delete-target", "delete-control"]) {
      assert.equal((await f.request(`/api/files/${name}`, "owner", "PUT", scene)).status, 200);
      const listed = await f.request("/api/diagrams", "owner");
      assert.equal(listed.status, 200);
      const diagram = listed.body.diagrams.find((entry) => entry.name === name);
      assert.ok(diagram, `Missing deletion fixture diagram: ${name}`);
      rooms.push(diagram.id);
    }
    const [target, control] = rooms;
    assert.equal((await f.request(`/api/diagrams/${target}/members`, "owner", "POST",
      { username: "member" })).status, 201);
    // Hold and fail the actual unlink through the public fixture, without permissions assumptions.
    const barrier = cleanupFails
      ? await f.storageBarrier("unlink", f.backups.relative("owner", "delete-target"), true) : null;
    const peers = [];
    const open = async (id, user) => {
      const peer = realtimePeer(id, f.cookieFor(user), { deadlineMs: 750,
        deadlineMessage: `${user} deletion transport event missing within 750 ms` });
      peers.push(peer);
      const ready = await peer.next();
      assert.equal(ready.type, "message");
      assert.deepEqual(JSON.parse(ready.data.toString("utf8")), { type: "ready", diagramId: id });
      return { peer, readyAt: performance.now(), user };
    };
    try {
      const other = await open(control, "owner");
      const affected = [await open(target, "owner"), await open(target, "member")];
      const startedAt = performance.now();
      const retired = Promise.all(affected.map(async ({ peer, readyAt, user }) => {
        const event = await peer.next();
        const observedAt = performance.now();
        assert.equal(event.type, "close", `${user}'s deleted-diagram transport must emit close`);
        assert.ok(observedAt - startedAt < 750,
          `${user}'s close must occur within 750 ms of starting DELETE`);
        assert.ok(observedAt - readyAt < 2000,
          `${user}'s close must occur within 2000 ms of ready, excluding the five-second watchdog`);
        assert.equal(peer.open, false);
      }));
      const deletion = f.request("/api/files/delete-target", "owner", "DELETE");
      // Consume all branches immediately; release cleanup even if retirement fails.
      const [response] = await Promise.all([deletion, retired, (async () => {
        if (!barrier) return;
        try {
          await Promise.all([barrier.blocked, retired]);
          assert.equal(other.peer.open, true, "Diagram B must stay open while A cleanup is blocked");
        } finally { barrier.release(); }
      })()]);
      expectResponse(response, cleanupFails ? 500 : 200, cleanupFails
        ? { error: "Se produjo un error interno en el servidor." }
        : { ok: true, file: { name: "delete-target", fileName: "delete-target.excalidraw.json" } });
      assert.equal(other.peer.open, true, "Deleting diagram A must leave diagram B's transport open");
      assert.deepEqual((await readdir(f.backups.directory("owner"))).sort(), cleanupFails
        ? ["delete-control.excalidraw.json", "delete-target.excalidraw.json"]
        : ["delete-control.excalidraw.json"]);
    } finally {
      barrier?.release();
      await Promise.all(peers.map((peer) => peer.dispose()));
    }
  });
}

for (const cleanupFails of [false, true]) {
  test(cleanupFails
    ? "admin account DELETE retires owned-diagram transports before failing directory cleanup"
    : "admin account DELETE promptly retires only owned-diagram transports before directory cleanup", { timeout: 60_000 }, async (t) => {
    const f = await persistenceFixture(t);
    const ownedNames = ["account-target-a", "account-target-b"];
    const owned = [];
    for (const name of ownedNames) {
      assert.equal((await f.request(`/api/files/${name}`, "owner", "PUT", scene)).status, 200);
      const listed = await f.request("/api/diagrams", "owner");
      assert.equal(listed.status, 200);
      const diagram = listed.body.diagrams.find((entry) => entry.name === name);
      assert.ok(diagram, `Missing account deletion fixture diagram: ${name}`);
      owned.push(diagram.id);
      assert.equal((await f.request(`/api/diagrams/${diagram.id}/members`, "owner", "POST",
        { username: "member" })).status, 201);
    }
    assert.equal((await f.request("/api/files/account-control", "stranger", "PUT", scene)).status, 200);
    const listed = await f.request("/api/diagrams", "stranger");
    assert.equal(listed.status, 200);
    const control = listed.body.diagrams.find((entry) => entry.name === "account-control");
    assert.ok(control, "Missing other account's control diagram");
    assert.equal((await f.request(`/api/diagrams/${control.id}/members`, "stranger", "POST",
      { username: "member" })).status, 201);
    const expectedFiles = ownedNames.map((name) => `${name}.excalidraw.json`).sort();
    const barrier = await f.storageBarrier("rm", f.backups.relative("owner"), cleanupFails);
    const peers = [];
    const open = async (id, user, deadlineMs = 3000) => {
      const peer = realtimePeer(id, f.cookieFor(user), { deadlineMs,
        deadlineMessage: `${user}'s account-deletion transport event missing within ${deadlineMs} ms` });
      peers.push(peer);
      const ready = await peer.next();
      assert.equal(ready.type, "message");
      assert.deepEqual(JSON.parse(ready.data.toString("utf8")), { type: "ready", diagramId: id });
      return { peer, readyAt: performance.now(), user };
    };
    try {
      const controlOwner = await open(control.id, "stranger");
      const controlMember = await open(control.id, "member");
      const affected = [];
      for (const id of owned) {
        for (const user of ["owner", "member"]) affected.push(await open(id, user, 750));
      }
      const startedAt = performance.now();
      const retired = Promise.all(affected.map(async ({ peer, readyAt, user }) => {
        const event = await peer.next();
        const observedAt = performance.now();
        assert.equal(event.type, "close", `${user}'s deleted-account diagram transport must emit close`);
        assert.ok(observedAt - startedAt < 750,
          `${user}'s close must occur within 750 ms of starting admin account DELETE`);
        assert.ok(observedAt - readyAt < 2000,
          `${user}'s close must occur within 2000 ms of ready, excluding the five-second watchdog`);
      }));
      const deletion = f.request(`/api/admin/users/${f.users.owner}`, "admin", "DELETE");
      const [response] = await Promise.all([deletion, retired, (async () => {
        try {
          await Promise.all([barrier.blocked, retired]);
          const accounts = await f.request("/api/admin/users", "admin");
          assert.equal(accounts.status, 200);
          assert.equal(accounts.body.users.some((user) => String(user.id) === String(f.users.owner)), false,
            "Account deletion must be confirmed while directory removal is blocked");
          assert.deepEqual((await readdir(f.backups.directory("owner"))).sort(), expectedFiles,
            "Owned transports must close before the account directory is removed");
        } finally { barrier.release(); }
      })()]);
      expectResponse(response, cleanupFails ? 500 : 200, cleanupFails
        ? { error: "Se produjo un error interno en el servidor." }
        : { ok: true, user: { id: f.users.owner, username: "owner" } });
      if (cleanupFails) {
        assert.deepEqual((await readdir(f.backups.directory("owner"))).sort(), expectedFiles);
      } else {
        await assert.rejects(readdir(f.backups.directory("owner")), { code: "ENOENT" });
      }
      controlOwner.peer.send({ type: "sync_request", payload: {} });
      const event = await controlMember.peer.next();
      assert.equal(event.type, "message", "Other account's transport must still receive broadcasts after deletion");
      assert.equal(event.binary, false);
      const frame = JSON.parse(event.data.toString("utf8"));
      assert.equal(frame.type, "sync_request");
      assert.deepEqual(frame.payload, {});
      assert.equal(frame.sender.userId, String(f.users.stranger));
      assert.deepEqual(await readdir(f.backups.directory("stranger")), ["account-control.excalidraw.json"]);
    } finally {
      barrier.release();
      await Promise.all(peers.map((peer) => peer.dispose()));
    }
  });
}

test("membership revocation promptly closes only the revoked member's diagram connection", { timeout: 60_000 }, async (t) => {
  const f = await persistenceFixture(t);
  const rooms = [];
  for (const name of ["revocation-target", "revocation-control"]) {
    assert.equal((await f.request(`/api/files/${name}`, "owner", "PUT", scene)).status, 200);
    const listed = await f.request("/api/diagrams", "owner");
    assert.equal(listed.status, 200);
    const diagram = listed.body.diagrams.find((entry) => entry.name === name);
    assert.ok(diagram, `Missing revocation fixture diagram: ${name}`);
    rooms.push(diagram.id);
    assert.equal((await f.request(`/api/diagrams/${diagram.id}/members`, "owner", "POST",
      { username: "member" })).status, 201);
  }
  const [target, control] = rooms;
  assert.equal((await f.request(`/api/diagrams/${target}/members`, "owner", "POST",
    { username: "stranger" })).status, 201);

  const peers = [];
  const open = async (room, user, deadlineMs = 3000, deadlineMessage) => {
    const peer = realtimePeer(room, f.cookieFor(user), { deadlineMs, deadlineMessage });
    peers.push(peer);
    const ready = await peer.next();
    assert.equal(ready.type, "message", `${user} must receive ready on diagram ${room}`);
    assert.deepEqual(JSON.parse(ready.data.toString("utf8")), { type: "ready", diagramId: room });
    return peer;
  };
  const expectBroadcast = async (peer, sender, message) => {
    const event = await peer.next();
    assert.equal(event.type, "message", message);
    assert.equal(event.binary, false, message);
    const frame = JSON.parse(event.data.toString("utf8"));
    assert.equal(frame.type, "sync_request", message);
    assert.deepEqual(frame.payload, {}, message);
    assert.equal(frame.sender.userId, String(f.users[sender]), message);
    assert.ok(frame.sender.peerId, message);
  };
  try {
    const targetOwner = await open(target, "owner");
    const survivor = await open(target, "stranger", 3000,
      "Surviving member did not receive the post-revocation broadcast");
    const controlOwner = await open(control, "owner");
    const controlMember = await open(control, "member", 3000,
      "Revoked member's connection on the second diagram did not receive a broadcast");
    // Open last; bound total age to 2000 ms so even a slow DELETE cannot let
    // the approximately five-second authorization watchdog explain the close.
    const revoked = await open(target, "member", 750,
      "Revoked member's socket did not emit close within 750 ms of successful revocation");
    const revokedReadyAt = performance.now();
    assert.equal((await f.request(`/api/diagrams/${target}/members/member`, "owner", "DELETE")).status, 200,
      "Owner must successfully revoke the target diagram membership");
    const revokedDeletedAt = performance.now();
    const closed = await revoked.next();
    const closeObservedAt = performance.now();
    assert.ok(closeObservedAt - revokedDeletedAt < 750,
      "Revoked member's close must be observed within 750 ms after successful DELETE");
    assert.ok(closeObservedAt - revokedReadyAt < 2000,
      "Revoked member's close must be observed within 2000 ms of ready to exclude watchdog expiry");
    assert.equal(closed.type, "close", "Revoked member must emit close, not another application frame");
    assert.equal(revoked.open, false, "Revoked member must no longer have an open target connection");

    targetOwner.send({ type: "sync_request", payload: {} });
    await expectBroadcast(survivor, "owner", "Surviving member must receive the post-revocation broadcast");
    assert.equal(survivor.open, true, "Other members on the target diagram must remain connected");
    controlOwner.send({ type: "sync_request", payload: {} });
    await expectBroadcast(controlMember, "owner", "Same member's second-diagram connection must remain usable");
    assert.equal(controlMember.open, true, "Revocation must not close the same member's second-diagram connection");
  } finally {
    await Promise.all(peers.map((peer) => peer.dispose()));
  }
});
