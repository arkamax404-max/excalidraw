import assert from "node:assert/strict";
import test from "node:test";
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
