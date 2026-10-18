// Real public UI/HTTP composition with the installed Excalidraw, no store hooks.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
const { test, expect } = createRequire(process.argv[1])("playwright/test");
// Known already-imported SVG v2, including the installed library's viewBox
// normalization. Seed these exact bytes/metadata; do not normalize expectations.
const file = {
  id: "image-file", mimeType: "image/svg+xml", created: 1700000000000,
  lastRetrieved: 1700000000001, version: 2,
  dataURL: "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" fill="red"/></svg>').toString("base64"),
};
const element = (type, id) => ({
  type, id, x: 300, y: 300, width: 80, height: 80, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: 123, version: 1,
  versionNonce: 456, isDeleted: false, boundElements: null, updated: 1700000000000,
  link: "https://example.invalid/fixture", locked: false,
  ...(type === "image" ? { fileId: file.id, status: "saved", scale: [1, 1], crop: null } : {}),
});
const scene = (elements, files = {}) => ({ type: "excalidraw", version: 2, elements,
  appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files });
const load = async (page, target) => {
  await page.getByRole("button", { name: "Recargar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${target}\\.excalidraw\\.json`) }).click();
  await expect(page.locator(".status")).toContainText("cargado.");
};
const save = async (page) => {
  const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/api/files/"));
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  expect(result.request().headers()["if-match"]).toMatch(/^"[1-9]\d*:1"$/);
  expect(result.headers().etag).toMatch(/^"[1-9]\d*:2"$/);
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
  return result;
};
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Usuario", exact: true }).fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
});

for (const deleted of [false, true]) {
  test(deleted ? "UI deletion retains tombstones and referenced binary" : "image binary survives UI save and reload", async ({ page }, info) => {
    const target = deleted ? "deleted-scene" : "image-scene";
    const image = element("image", "image-element");
    const decoy = { ...file, id: "other-document-file" };
    expect((await page.request.put(`/api/files/${target}-other-document`, { data: scene([
      { ...image, id: "decoy", fileId: decoy.id },
    ], { [decoy.id]: decoy }) })).status()).toBe(200);
    await load(page, `${target}-other-document`);
    expect((await page.request.put(`/api/files/${target}`, { data: scene([image], { [file.id]: file }) })).status()).toBe(200);
    await load(page, target);
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await canvas.click({ position: { x: 340, y: 340 } });
    await page.keyboard.press("Control+a");
    await page.keyboard.press(deleted ? "Backspace" : "ArrowRight");
    const result = await save(page);
    const sent = result.request().postDataJSON();
    await writeFile(info.outputPath("request.json"), JSON.stringify(sent, null, 2));
    await page.screenshot({ path: info.outputPath("saved.png") });
    // Separate assertions make both original omissions independently observable.
    const savedImage = sent.elements.find(e => e.id === image.id);
    expect.soft(savedImage?.isDeleted).toBe(deleted);
    expect.soft(savedImage).toMatchObject({ id: image.id, type: "image", fileId: file.id,
      width: image.width, height: image.height, angle: image.angle, link: image.link });
    expect.soft(savedImage?.version).toBeGreaterThan(image.version);
    if (!deleted) expect.soft(savedImage?.x).toBeGreaterThan(image.x);
    expect.soft(sent.files).toEqual({ [file.id]: file });
    const stored = await page.request.get(`/api/files/${target}`);
    expect(stored.headers().etag).toBe(result.headers().etag);
    const storedBody = await stored.json();
    await writeFile(info.outputPath("stored.json"), JSON.stringify(storedBody, null, 2));
    expect(storedBody.scene).toEqual(sent);
    await page.reload();
    await page.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
    await load(page, target);
    // Save-as exposes the reloaded scene via the actual UI serializer again.
    await page.getByRole("textbox", { name: "Nombre del diagrama" }).fill(`${target}-reloaded`);
    const pending = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("-reloaded"));
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    const reloaded = await pending;
    expect(reloaded.status()).toBe(200);
    expect(reloaded.request().headers()["if-match"]).toBeUndefined();
    expect(reloaded.headers().etag).toMatch(/:1"$/);
    const again = reloaded.request().postDataJSON();
    await writeFile(info.outputPath("reloaded.json"), JSON.stringify(again, null, 2));
    expect.soft(again.files).toEqual({ [file.id]: file });
    expect.soft(again.elements.find(e => e.id === image.id)).toEqual(sent.elements.find(e => e.id === image.id));
    await page.screenshot({ path: info.outputPath("reloaded.png") });
  });
}

test("unaffected public request preserves JSON structure and values", async ({ page }, info) => {
  // Replay the baseline's canonical element indices/versions so restore does not
  // generate unrelated timestamps/nonces when comparing two isolated runs.
  const baseline = process.env.T3C2_BASELINE ? await readFile(process.env.T3C2_BASELINE, "utf8") : null;
  const input = baseline ? JSON.parse(baseline) : scene([element("rectangle", "plain")]);
  expect((await page.request.put("/api/files/plain", { data: input })).status()).toBe(200);
  await load(page, "plain");
  const response = await save(page);
  const body = response.request().postData();
  await writeFile(info.outputPath("unaffected.json"), body);
  // Ignore object-key order only; retain array order and every JSON value.
  if (baseline) expect(JSON.parse(body)).toEqual(JSON.parse(baseline));
});
