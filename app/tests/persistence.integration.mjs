import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { persistenceFixture } from "./helpers/persistence-fixture.mjs";

const scene = { elements: [{ id: "tombstone", isDeleted: true }],
  appState: { scrollX: 17 }, files: { image: { dataURL: "data:image/png;base64,AA==" } } };
const expect = (result, status, body) => {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
};

test("persistence fixture anchors current unguarded legacy behavior", { timeout: 60_000 }, async (t) => {
  const { request, snapshot } = await persistenceFixture(t);
  const legacy = "/api/files/shared-scene";
  const created = await request("/api/files/Shared Scene!!", "owner", "PUT", scene);
  assert.equal(created.status, 200);
  assert.match(created.etag, /^"[1-9][0-9]*:1"$/);
  const id = created.etag.slice(1).split(":")[0];
  const route = `/api/diagrams/${id}`;
  const file = created.body.file;
  assert.match(file.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(created, 200, { ok: true, file: { name: "shared-scene",
    fileName: "shared-scene.excalidraw.json", updatedAt: file.updatedAt } });
  const metadata = (revision, savedFile = file) => ({ id, revision, ...savedFile });

  await t.test("raw scene, revision token, listings and backup agree after create", async () => {
    expect(await request(legacy, "owner"), 200, { file, scene });
    const loaded = await request(route, "owner");
    expect(loaded, 200, { diagram: metadata("1"), scene });
    assert.equal(loaded.etag, created.etag);
    assert.equal((await request(legacy, "owner")).etag, created.etag);
    expect(await request("/api/diagrams", "owner"), 200, { diagrams: [metadata("1")] });
    expect(await request("/api/files", "owner"), 200, { files: [file] });
    assert.deepEqual((await snapshot(id, "shared-scene")).backups,
      { "owner/shared-scene.excalidraw.json": `${JSON.stringify(scene, null, 2)}\n` });
  });

  await t.test("member reads share identity without changing ownership or backup location", async () => {
    const granted = await request(`${route}/members`, "owner", "POST", { username: "member" });
    assert.equal(granted.status, 201);
    const loaded = await request(route, "member");
    expect(loaded, 200, { diagram: metadata("1"), scene });
    assert.equal(loaded.etag, created.etag);
    expect(await request("/api/diagrams", "member"), 200, { diagrams: [metadata("1")] });
    expect(await request("/api/files", "member"), 200, { files: [] });
    expect(await request(legacy, "member"), 404, { error: "El diagrama solicitado no existe." });
  });

  await t.test("rejected writes and private reads preserve complete public state and backup bytes", async () => {
    const before = await snapshot(id, "shared-scene");
    expect(await request(legacy, "owner", "PUT", { elements: "invalid" }), 400,
      { error: "El contenido del diagrama no es valido." });
    expect(await request(legacy, null, "PUT", scene), 401, { error: "Necesitas iniciar sesion." });
    for (const user of ["stranger", "admin"]) {
      expect(await request(route, user), 404, { error: "El diagrama solicitado no existe." });
      expect(await request("/api/diagrams", user), 200, { diagrams: [] });
    }
    assert.deepEqual(await snapshot(id, "shared-scene"), before);
  });

  await t.test("legacy replacement remains blind, retains ID and advances its exact token once", async () => {
    const replacement = { ...scene, elements: [...scene.elements, { id: "new", isDeleted: false }] };
    const saved = await request(legacy, "owner", "PUT", replacement);
    assert.equal(saved.status, 200);
    assert.equal(saved.etag, `"${id}:2"`);
    expect(saved, 200, { ok: true, file: { ...file, updatedAt: saved.body.file.updatedAt } });
    const loaded = await request(route, "member");
    expect(loaded, 200, { diagram: metadata("2", saved.body.file), scene: replacement });
    assert.equal(loaded.etag, saved.etag);
    expect(await request(legacy, "owner"), 200, { file: saved.body.file, scene: replacement });
    expect(await request("/api/files", "owner"), 200, { files: [saved.body.file] });
    expect(await request("/api/diagrams", "owner"), 200, { diagrams: [metadata("2", saved.body.file)] });
    assert.deepEqual((await snapshot(id, "shared-scene")).backups,
      { "owner/shared-scene.excalidraw.json": `${JSON.stringify(replacement, null, 2)}\n` });
  });
});

test("guarded stable-ID persistence contracts", { timeout: 60_000 }, async (t) => {
  const { request, snapshot, setup, directory, logs } = await persistenceFixture(t);
  const created = await request("/api/files/guarded", "owner", "PUT", scene);
  const id = created.etag.slice(1).split(":")[0];
  const route = `/api/diagrams/${id}`;
  let token = created.etag;
  const save = (user, match = token, body = scene, url = route) =>
    request(url, user, "PUT", body, match === null ? {} : { "If-Match": match });
  const missing = { error: "El diagrama solicitado no existe." };
  const unchanged = async (action, status, body) => {
    const before = await snapshot(id, "guarded");
    const result = await action();
    expect(result, status, body);
    assert.notEqual(result.etag, token);
    assert.equal(result.warning, null);
    assert.deepEqual(await snapshot(id, "guarded"), before);
  };
  await request(`${route}/members`, "owner", "POST", { username: "member" });

  await t.test("authentication, ID validation and scoped access precede preconditions", async () => {
    await unchanged(() => save(null, null, {}, "/api/diagrams/invalid"), 401,
      { error: "Necesitas iniciar sesion." });
    await unchanged(() => save("owner", null, scene, "/api/diagrams/01"), 400,
      { error: "El identificador de diagrama no es valido." });
    for (const user of ["stranger", "admin"]) {
      await unchanged(() => save(user, null), 404, missing);
      await unchanged(() => save(user, "invalid"), 404, missing);
    }
    await unchanged(() => save("owner", null, scene, "/api/diagrams/9223372036854775807"), 404, missing);
  });
  await t.test("canonical identity-bearing preconditions and invalid scenes have no effects", async () => {
    await unchanged(() => save("owner", null), 428, { error: "Debes indicar If-Match." });
    for (const match of ["", "*", `W/${token}`, `${token}, ${token}`, '"01:1"', '"1:01"',
      '"1:0"', '"0:1"', '"1:9223372036854775808"', '"9223372036854775808:1"',
      '"1:1.0"', '"1:1e1"', '"1:+1"', '"1:-1"', '"1: 1"']) {
      await unchanged(() => save("owner", match), 400, { error: "If-Match no es valido." });
    }
    for (const match of [`"${id}:2"`, '"9223372036854775807:1"']) {
      await unchanged(() => save("owner", match), 412, { error: "La version del diagrama no coincide." });
    }
    await unchanged(() => save("owner", token, {}), 400,
      { error: "El contenido del diagrama no es valido." });
  });
  await t.test("owner and member replace raw scenes into the stored owner's backup", async () => {
    for (const [index, user] of ["owner", "member"].entries()) {
      const replacement = { ...scene, elements: [...scene.elements, { id: user }] };
      const saved = await save(user, token, replacement);
      assert.equal(saved.status, 200);
      assert.equal(saved.warning, null);
      token = `"${id}:${index + 2}"`;
      assert.equal(saved.etag, token);
      expect(saved, 200, { ok: true, diagram: { id, revision: String(index + 2),
        name: "guarded", fileName: "guarded.excalidraw.json", updatedAt: saved.body.diagram.updatedAt } });
      const loaded = await request(route, "member");
      expect(loaded, 200, { diagram: saved.body.diagram, scene: replacement });
      assert.equal(loaded.etag, token);
      assert.deepEqual((await snapshot(id, "guarded")).backups,
        { "owner/guarded.excalidraw.json": `${JSON.stringify(replacement, null, 2)}\n` });
    }
    await unchanged(() => save("owner", created.etag), 412, { error: "La version del diagrama no coincide." });
  });
  await t.test("revoked and inactive existing sessions cannot save", async () => {
    await request(`${route}/members/member`, "owner", "DELETE");
    await unchanged(() => save("member"), 404, missing);
    await request(`${route}/members`, "owner", "POST", { username: "member" });
    await setup("UPDATE fixture_schema.users SET is_active = FALSE WHERE username = 'member'");
    await unchanged(() => save("member"), 404, missing);
    await setup("UPDATE fixture_schema.users SET is_active = TRUE WHERE username = 'member'");
  });
  await t.test("same-token concurrent saves yield one winner, one conflict and one increment", async () => {
    const pair = await Promise.all([save("owner"), save("member")]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [200, 412]);
    const winner = pair.find((r) => r.status === 200);
    expect(pair.find((r) => r.status === 412), 412, { error: "La version del diagrama no coincide." });
    token = `"${id}:4"`;
    assert.equal(winner.etag, token);
    const loaded = await request(route, "owner");
    expect(loaded, 200, { diagram: winner.body.diagram, scene });
    assert.equal(loaded.etag, token);
    assert.equal((await snapshot(id, "guarded")).backups["owner/guarded.excalidraw.json"],
      `${JSON.stringify(scene, null, 2)}\n`);
  });
  await t.test("SQL rollback releases coordination and recovery can use the same token", async () => {
    await setup(`CREATE FUNCTION fixture_schema.reject_save() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'isolated update fault'; END $$;
      CREATE TRIGGER reject_save BEFORE UPDATE ON fixture_schema.diagrams
      FOR EACH ROW EXECUTE FUNCTION fixture_schema.reject_save()`);
    await unchanged(() => save("owner"), 500, { error: "Se produjo un error interno en el servidor." });
    await setup("DROP TRIGGER reject_save ON fixture_schema.diagrams");
    const recovered = await save("owner");
    assert.equal(recovered.status, 200);
    token = `"${id}:5"`;
    assert.equal(recovered.etag, token);
  });
  await t.test("large identity and last representable revision remain exact strings", async () => {
    const precise = "9007199254740993";
    await setup(`INSERT INTO fixture_schema.diagrams (id, user_id, name, scene_json, revision)
      SELECT $1, id, 'precise', $2::jsonb, 9223372036854775806
      FROM fixture_schema.users WHERE username = 'owner'`, [precise, JSON.stringify(scene)]);
    const url = `/api/diagrams/${precise}`;
    const saved = await save("owner", `"${precise}:9223372036854775806"`, scene, url);
    assert.equal(saved.status, 200);
    assert.equal(saved.etag, `"${precise}:9223372036854775807"`);
    assert.equal(saved.body.diagram.id, precise);
    assert.equal(saved.body.diagram.revision, "9223372036854775807");
    const before = await snapshot(precise, "precise");
    expect(await save("owner", saved.etag, scene, url), 409,
      { error: "El diagrama ha alcanzado el limite de revisiones." });
    assert.deepEqual(await snapshot(precise, "precise"), before);
  });
  await t.test("maximum revision rejects without canonical or backup effects", async () => {
    await setup("UPDATE fixture_schema.diagrams SET revision = 9223372036854775807 WHERE id = $1", [id]);
    token = `"${id}:9223372036854775807"`;
    await unchanged(() => save("owner"), 409,
      { error: "El diagrama ha alcanzado el limite de revisiones." });
  });
  await t.test("post-commit backup failure is canonical success with a safe warning", async () => {
    await setup(`INSERT INTO fixture_schema.diagrams (user_id, name, scene_json)
      SELECT id, 'blocked', $1::jsonb FROM fixture_schema.users WHERE username = 'owner'`, [JSON.stringify(scene)]);
    await mkdir(path.join(directory, "owner", "blocked.excalidraw.json"));
    const listed = await request("/api/diagrams", "owner");
    const target = listed.body.diagrams.find((diagram) => diagram.name === "blocked");
    const url = `/api/diagrams/${target.id}`;
    const old = `"${target.id}:1"`;
    const replacement = { elements: [] };
    const backupsBefore = (await snapshot(target.id, "blocked")).backups;
    const saved = await save("owner", old, replacement, url);
    assert.equal(saved.status, 200);
    assert.equal(saved.warning, "diagram-backup-failed");
    assert.equal(saved.etag, `"${target.id}:2"`);
    expect(saved, 200, { ok: true, diagram: { ...target, revision: "2", updatedAt: saved.body.diagram.updatedAt },
      warning: "diagram-backup-failed" });
    const loaded = await request(url, "owner");
    expect(loaded, 200, { diagram: saved.body.diagram, scene: replacement });
    assert.equal(loaded.etag, saved.etag);
    assert.match(logs(), /Canonical diagram saved; backup failed\./);
    const after = await snapshot(target.id, "blocked");
    assert.deepEqual(after.backups, backupsBefore);
    expect(await save("owner", old, replacement, url), 412, { error: "La version del diagrama no coincide." });
    assert.deepEqual(await snapshot(target.id, "blocked"), after);
  });
});
