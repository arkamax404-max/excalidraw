import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { persistenceFixture } from "./helpers/persistence-fixture.mjs";

const scene = { elements: [{ id: "tombstone", isDeleted: true }],
  appState: { scrollX: 17 }, files: { image: { dataURL: "data:image/png;base64,AA==" } } };
const expect = (result, status, body) => {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
};

test("persistence fixture anchors guarded legacy behavior", { timeout: 60_000 }, async (t) => {
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
    expect(await request(legacy, "owner", "PUT", { elements: "invalid" }, { "If-Match": created.etag }), 400,
      { error: "El contenido del diagrama no es valido." });
    expect(await request(legacy, null, "PUT", scene), 401, { error: "Necesitas iniciar sesion." });
    for (const user of ["stranger", "admin"]) {
      expect(await request(route, user), 404, { error: "El diagrama solicitado no existe." });
      expect(await request("/api/diagrams", user), 200, { diagrams: [] });
    }
    assert.deepEqual(await snapshot(id, "shared-scene"), before);
  });

  await t.test("legacy replacement retains ID and advances its exact token once", async () => {
    const replacement = { ...scene, elements: [...scene.elements, { id: "new", isDeleted: false }] };
    const saved = await request(legacy, "owner", "PUT", replacement, { "If-Match": created.etag });
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
    const next = await request("/api/files/after-replacement", "owner", "PUT", scene);
    assert.equal(next.status, 200);
    assert.equal(next.etag, `"${BigInt(id) + 2n}:1"`, "legacy replacement retains historical ID allocation");
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

test("legacy saves share guarded owner/name persistence", { timeout: 60_000 }, async (t) => {
  const { request, snapshot, setup, directory } = await persistenceFixture(t);
  const url = "/api/files/Legacy Name!!";
  const first = await request(url, "owner", "PUT", scene);
  assert.equal(first.status, 200);
  const id = first.etag.slice(1).split(":")[0];
  const save = (token, body = scene, user = "owner") => request(url, user, "PUT", body,
    token === undefined ? {} : { "If-Match": token });
  const rejected = async (token, status, error) => {
    const before = await snapshot(id, "legacy-name");
    const result = await save(token);
    expect(result, status, { error });
    assert.equal(result.warning, null);
    assert.notEqual(result.etag, first.etag);
    assert.deepEqual(await snapshot(id, "legacy-name"), before);
  };
  await t.test("existing normalized names require the caller's exact identity token", async () => {
    await rejected(undefined, 428, "Debes indicar If-Match.");
    for (const token of ["*", `W/${first.etag}`, `${first.etag}, ${first.etag}`, '"01:1"',
      '"1:0"', '"1:9223372036854775808"']) {
      await rejected(token, 400, "If-Match no es valido.");
    }
    await rejected(`"${id}:2"`, 412, "La version del diagrama no coincide.");
    await rejected('"9223372036854775807:1"', 412, "La version del diagrama no coincide.");
  });
  await t.test("legacy and ID same-token competitors preserve the distinct winning scene and backup", async () => {
    const variants = [{ ...scene, elements: [{ id: "legacy" }] }, { ...scene, elements: [{ id: "id" }] }];
    const pair = await Promise.all([save(first.etag, variants[0]),
      request(`/api/diagrams/${id}`, "owner", "PUT", variants[1], { "If-Match": first.etag })]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [200, 412]);
    const winner = pair.findIndex((r) => r.status === 200);
    assert.equal(pair[winner].etag, `"${id}:2"`);
    expect(pair[1 - winner], 412, { error: "La version del diagrama no coincide." });
    const loaded = await request(`/api/diagrams/${id}`, "owner");
    assert.equal(loaded.etag, pair[winner].etag);
    assert.equal(loaded.body.diagram.revision, "2");
    assert.deepEqual(loaded.body.scene, variants[winner]);
    assert.equal((await snapshot(id, "legacy-name")).backups["owner/legacy-name.excalidraw.json"],
      `${JSON.stringify(variants[winner], null, 2)}\n`);
    await rejected(first.etag, 412, "La version del diagrama no coincide.");
  });
  await t.test("member names stay private and normalized fresh-name competitors never upsert", async () => {
    await request(`/api/diagrams/${id}/members`, "owner", "POST", { username: "member" });
    expect(await save(first.etag, scene, "member"), 412, { error: "La version del diagrama no coincide." });
    expect(await request("/api/files/legacy-name", "member"), 404, { error: "El diagrama solicitado no existe." });
    await setup("UPDATE fixture_schema.users SET is_active = FALSE WHERE username = 'owner'");
    await rejected(undefined, 404, "El diagrama solicitado no existe.");
    await setup("UPDATE fixture_schema.users SET is_active = TRUE WHERE username = 'owner'");
    const variants = [{ elements: [{ id: "one" }] }, { elements: [{ id: "two" }] }];
    const pair = await Promise.all([request("/api/files/Fresh Name!!", "owner", "PUT", variants[0]),
      request("/api/files/fresh-name", "owner", "PUT", variants[1])]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [200, 428]);
    const winner = pair.findIndex((r) => r.status === 200);
    expect(pair[1 - winner], 428, { error: "Debes indicar If-Match." });
    assert.match(pair[winner].etag, /^"[1-9][0-9]*:1"$/);
    const loaded = await request("/api/files/fresh-name", "owner");
    expect(loaded, 200, { file: pair[winner].body.file, scene: variants[winner] });
    assert.equal(loaded.etag, pair[winner].etag);
    assert.equal((await snapshot(id, "legacy-name")).backups["owner/fresh-name.excalidraw.json"],
      `${JSON.stringify(variants[winner], null, 2)}\n`);
  });
  await t.test("deleted identity cannot recreate a name or overwrite its replacement identity", async () => {
    assert.equal((await request(url, "owner", "DELETE")).status, 200);
    await rejected("*", 400, "If-Match no es valido.");
    await rejected(first.etag, 412, "La version del diagrama no coincide.");
    const recreated = await save();
    assert.equal(recreated.status, 200);
    assert.notEqual(recreated.etag, first.etag);
    await rejected(first.etag, 412, "La version del diagrama no coincide.");
  });
  await t.test("legacy SQL rollback recovers without a backup write or stuck session", async () => {
    const current = await request(url, "owner");
    await setup(`CREATE FUNCTION fixture_schema.reject_legacy() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'isolated legacy fault'; END $$;
      CREATE TRIGGER reject_legacy BEFORE UPDATE ON fixture_schema.diagrams
      FOR EACH ROW EXECUTE FUNCTION fixture_schema.reject_legacy()`);
    await rejected(current.etag, 500, "Se produjo un error interno en el servidor.");
    await setup("DROP TRIGGER reject_legacy ON fixture_schema.diagrams");
    assert.equal((await save(current.etag)).status, 200);
  });
  await t.test("legacy create backup failure returns canonical success and never repeats creation", async () => {
    await mkdir(path.join(directory, "owner", "blocked-legacy.excalidraw.json"));
    const blocked = "/api/files/blocked-legacy";
    const saved = await request(blocked, "owner", "PUT", scene);
    expect(saved, 200, { ok: true, file: { name: "blocked-legacy", fileName: "blocked-legacy.excalidraw.json",
      updatedAt: saved.body.file.updatedAt }, warning: "diagram-backup-failed" });
    assert.equal(saved.warning, "diagram-backup-failed");
    assert.match(saved.etag, /^"[1-9][0-9]*:1"$/);
    const loaded = await request(blocked, "owner");
    expect(loaded, 200, { file: saved.body.file, scene });
    assert.equal(loaded.etag, saved.etag);
    const before = await snapshot(id, "legacy-name");
    expect(await request(blocked, "owner", "PUT", scene), 428, { error: "Debes indicar If-Match." });
    assert.deepEqual(await snapshot(id, "legacy-name"), before);
    const replacement = { elements: [] };
    const updated = await request(blocked, "owner", "PUT", replacement, { "If-Match": saved.etag });
    assert.equal(updated.status, 200);
    assert.equal(updated.warning, "diagram-backup-failed");
    expect(updated, 200, { ok: true, file: { ...saved.body.file, updatedAt: updated.body.file.updatedAt },
      warning: "diagram-backup-failed" });
    assert.equal(updated.etag, saved.etag.replace(":1\"", ":2\""));
    expect(await request(blocked, "owner"), 200, { file: updated.body.file, scene: replacement });
    const after = await snapshot(id, "legacy-name");
    expect(await request(blocked, "owner", "PUT", scene, { "If-Match": saved.etag }), 412,
      { error: "La version del diagrama no coincide." });
    assert.deepEqual(await snapshot(id, "legacy-name"), after);
  });
});

test("diagram deletion orders canonical changes and backup completion", { timeout: 60_000 }, async (t) => {
  const f = await persistenceFixture(t);
  const { request, snapshot, storageBarrier, blocked, documentLock } = f;
  const legacy = "/api/files/ordered";
  const missing = { error: "El diagrama solicitado no existe." };
  const deleted = { ok: true, file: { name: "ordered", fileName: "ordered.excalidraw.json" } };
  const other = await request(legacy, "stranger", "PUT", scene);
  const otherBefore = await request(legacy, "stranger");
  const assertDeleted = async (id) => {
    expect(await request(`/api/diagrams/${id}`, "member"), 404, missing);
    expect(await request(legacy, "owner"), 404, missing);
    expect(await request("/api/diagrams", "owner"), 200, { diagrams: [] });
    expect(await request("/api/diagrams", "member"), 200, { diagrams: [] });
    assert.deepEqual((await snapshot(id, "ordered")).backups,
      { "stranger/ordered.excalidraw.json": `${JSON.stringify(scene, null, 2)}\n` });
    expect(await request(legacy, "stranger"), 200, otherBefore.body);
    assert.equal((await request(legacy, "stranger")).etag, other.etag);
  };
  for (const mode of ["legacy", "member-ID"]) {
    await t.test(`${mode} backup finishes before queued deletion`, async () => {
      const created = await request(legacy, "owner", "PUT", scene);
      const id = created.etag.slice(1).split(":")[0];
      await request(`/api/diagrams/${id}/members`, "owner", "POST", { username: "member" });
      const barrier = await storageBarrier("writeFile", "owner/ordered.excalidraw.json");
      const replacement = { elements: [{ id: mode }] };
      const saving = request(mode === "legacy" ? legacy : `/api/diagrams/${id}`,
        mode === "legacy" ? "owner" : "member", "PUT", replacement, { "If-Match": created.etag });
      await barrier.blocked;
      const removing = request(legacy, "owner", "DELETE");
      try {
        await blocked(1);
        const canonical = await request(`/api/diagrams/${id}`, "member");
        assert.equal(canonical.etag, `"${id}:2"`);
        assert.deepEqual(canonical.body.scene, replacement);
      } finally {
        barrier.release();
        await Promise.all([saving, removing]);
      }
      assert.equal((await saving).status, 200);
      expect(await removing, 200, deleted);
      await assertDeleted(id);
    });
    await t.test(`${mode} queued old identity cannot resurrect deletion or contaminate recreation`, async () => {
      const created = await request(legacy, "owner", "PUT", scene);
      const id = created.etag.slice(1).split(":")[0];
      await request(`/api/diagrams/${id}/members`, "owner", "POST", { username: "member" });
      const barrier = await storageBarrier("unlink", "owner/ordered.excalidraw.json");
      const unlock = await documentLock("ordered");
      let saving;
      const removing = request(legacy, "owner", "DELETE");
      try {
        try {
          await blocked(1);
          saving = request(mode === "legacy" ? legacy : `/api/diagrams/${id}`,
            mode === "legacy" ? "owner" : "member", "PUT", { elements: [{ id: "stale" }] },
            { "If-Match": created.etag });
          await blocked(2);
        } finally { await unlock(); }
        await barrier.blocked;
        await blocked(1);
        expect(await request(legacy, "owner"), 404, missing);
      } finally {
        barrier.release();
        await Promise.all([removing, saving]);
      }
      expect(await removing, 200, deleted);
      expect(await saving, mode === "legacy" ? 412 : 404,
        mode === "legacy" ? { error: "La version del diagrama no coincide." } : missing);
      await assertDeleted(id);
      const recreated = await request(legacy, "owner", "PUT", scene);
      assert.notEqual(recreated.etag, created.etag);
      const before = await snapshot(id, "ordered");
      expect(await request(legacy, "owner", "PUT", { elements: [] }, { "If-Match": created.etag }),
        412, { error: "La version del diagrama no coincide." });
      assert.deepEqual(await snapshot(id, "ordered"), before);
      expect(await request(`/api/diagrams/${id}`, "member"), 404, missing);
      expect(await request(legacy, "owner", "DELETE"), 200, deleted);
    });
  }
  await t.test("DELETE permissions, missing and ENOENT preserve existing contracts", async () => {
    const created = await request(legacy, "owner", "PUT", scene);
    const id = created.etag.slice(1).split(":")[0];
    await request(`/api/diagrams/${id}/members`, "owner", "POST", { username: "member" });
    const before = await snapshot(id, "ordered");
    expect(await request(legacy, null, "DELETE"), 401, { error: "Necesitas iniciar sesion." });
    for (const user of ["member", "admin"]) expect(await request(legacy, user, "DELETE"), 404, missing);
    assert.deepEqual(await snapshot(id, "ordered"), before);
    await unlink(path.join(f.directory, "owner/ordered.excalidraw.json"));
    expect(await request("/api/files/Ordered!!", "owner", "DELETE", undefined, { "If-Match": "invalid" }),
      200, deleted);
    expect(await request(legacy, "owner", "DELETE"), 404, missing);
    await assertDeleted(id);
  });
  await t.test("SQL failure rolls back; cleanup failure is 500 after deletion; both release coordination", async () => {
    const created = await request(legacy, "owner", "PUT", scene);
    const id = created.etag.slice(1).split(":")[0];
    const before = await snapshot(id, "ordered");
    await f.setup(`CREATE FUNCTION fixture_schema.reject_delete() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'isolated delete fault'; END $$;
      CREATE TRIGGER reject_delete BEFORE DELETE ON fixture_schema.diagrams
      FOR EACH ROW EXECUTE FUNCTION fixture_schema.reject_delete()`);
    const internal = { error: "Se produjo un error interno en el servidor." };
    expect(await request(legacy, "owner", "DELETE"), 500, internal);
    assert.deepEqual(await snapshot(id, "ordered"), before);
    await f.setup("DROP TRIGGER reject_delete ON fixture_schema.diagrams");
    const barrier = await storageBarrier("unlink", "owner/ordered.excalidraw.json", true);
    const removing = request(legacy, "owner", "DELETE");
    await barrier.blocked;
    barrier.release();
    const failed = await removing;
    expect(failed, 500, internal);
    assert.equal(failed.warning, null);
    expect(await request(legacy, "owner"), 404, missing);
    expect(await request(`/api/diagrams/${id}`, "owner"), 404, missing);
    expect(await request("/api/files", "owner"), 200, { files: [] });
    assert.deepEqual((await snapshot(id, "ordered")).backups, before.backups);
    const recovered = await request(legacy, "owner", "PUT", { elements: [] });
    assert.equal(recovered.status, 200);
    assert.notEqual(recovered.etag, created.etag);
    expect(await request(legacy, "owner", "DELETE"), 200, deleted);
    await assertDeleted(id);
  });
});
