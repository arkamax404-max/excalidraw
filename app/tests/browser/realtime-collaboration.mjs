import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const { test, expect } = createRequire(process.argv[1])("playwright/test");

// Same public login/load/save flow as scene-persistence.mjs; no editor hooks.
const login = async (page, username) => {
  page.setDefaultTimeout(10000);
  await page.goto("/");
  await page.getByRole("textbox", { name: "Usuario", exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
  await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
};
const load = async (page, name) => {
  // Subscribe before opening: the initial relay frame proves room readiness.
  const ready = page.waitForEvent("websocket", { timeout: 5000,
    predicate: socket => socket.url().includes("/api/realtime/diagrams/") })
    .then(socket => socket.waitForEvent("framereceived", { timeout: 5000 }));
  // Consume an early timeout even if a UI operation fails first.
  ready.catch(() => {});
  await page.getByRole("button", { name: "Recargar", exact: true }).click();
  // The list renders item.fileName: exactly the name plus .excalidraw.json.
  const rowButton = page.locator("li.file-row button.file-button").filter({
    has: page.locator(".file-name", { hasText: new RegExp(`^${name}\\.excalidraw\\.json$`) }),
  });
  await expect(rowButton, `file list shows the diagram ${name}`).toHaveCount(1, { timeout: 10000 });
  await rowButton.click();
  await expect(page.locator(".status")).toContainText("cargado.");
  await ready;
};
const save = async (page) => {
  const pending = page.waitForResponse(response => response.request().method() === "PUT"
    && response.url().includes("/api/files/"), { timeout: 10000 });
  pending.catch(() => {});
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
  return response;
};
const scene = {
  type: "excalidraw", version: 2,
  elements: [{ type: "rectangle", id: "shared-shape", x: 300, y: 300,
    width: 80, height: 80, angle: 0, strokeColor: "#1e1e1e",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: 123, version: 1, versionNonce: 456, isDeleted: false,
    boundElements: null, updated: 1700000000000, link: null, locked: false }],
  appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  files: {},
};
// Screenshot the actual canvas region, including the underlying static canvas,
// not just the transparent interactive canvas. Keep toolbars/pointers outside it.
const picture = async (page) => {
  const box = await page.locator(".excalidraw__canvas.interactive").boundingBox();
  expect(box, "Mounted canvas has bounds").not.toBeNull();
  return (await page.screenshot({ clip: { x: box.x + 280, y: box.y + 280,
    width: 120, height: 120 }, animations: "disabled" })).toString("base64");
};

test("saved scene reaches an open peer without reload and leaves another diagram unchanged", async ({ browser, baseURL }) => {
  test.setTimeout(30000);
  const contexts = [];
  const errors = [];
  try {
    for (let i = 0; i < 2; i++) contexts.push(await browser.newContext({ baseURL }));
    for (const context of contexts) context.on("page", page => {
      page.on("pageerror", error => errors.push(error.message));
    });
    const a = await contexts[0].newPage();
    const b = await contexts[1].newPage();
    const control = await contexts[1].newPage();
    await login(a, "owner");
    await login(b, "member");
    await control.goto("/");
    control.setDefaultTimeout(10000);
    await control.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
    await expect(control.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await b.mouse.move(10, 10);
    const blank = await picture(b);
    const name = `realtime-${randomUUID()}`;
    const seeded = await a.request.put(`/api/files/${name}`, { data: scene, timeout: 10000 });
    expect(seeded.status()).toBe(200);
    const identity = seeded.headers().etag?.match(/^"([1-9]\d*):1"$/);
    expect(identity, "New diagram response identifies its realtime room").not.toBeNull();
    // Public authenticated HTTP requests, as in the persistence fixture.
    const shared = await a.request.post(`/api/diagrams/${identity[1]}/members`, {
      data: { username: "member" }, timeout: 10000,
    });
    expect(shared.status()).toBe(201);
    expect((await b.request.put(`/api/files/${name}-control`, {
      data: scene, timeout: 10000,
    })).status()).toBe(200);
    await load(a, name);
    await load(b, name);
    await load(control, `${name}-control`);
    await expect.poll(() => picture(b), { timeout: 2000,
      message: "Peer initially renders the shared shape" }).not.toBe(blank);
    await expect.poll(() => picture(control), { timeout: 2000,
      message: "Control initially renders its independent shape" }).not.toBe(blank);
    // An element drawn but never saved must still reach the peer.
    const beforeDrawing = await picture(b);
    const canvasBox = await a.locator(".excalidraw__canvas.interactive").boundingBox();
    await a.mouse.move(canvasBox.x + 300, canvasBox.y + 300);
    await a.keyboard.press("r");
    await a.mouse.down();
    await a.mouse.move(canvasBox.x + 350, canvasBox.y + 350, { steps: 5 });
    await a.mouse.up();
    await expect.poll(() => picture(b), { timeout: 2000, intervals: [50, 100, 200],
      message: "A's new unsaved element must appear in B's canvas within 2s" }).not.toBe(beforeDrawing);
    // The member's own unsaved drawing must reach the owner, even while the
    // owner holds local unsaved changes of its own (the old deadlock).
    const drawAt = async (page, dx, dy) => {
      const box = await page.locator(".excalidraw__canvas.interactive").boundingBox();
      await page.mouse.move(box.x + dx, box.y + dy);
      await page.keyboard.press("r");
      await page.mouse.down();
      await page.mouse.move(box.x + dx + 40, box.y + dy + 40, { steps: 5 });
      await page.mouse.up();
    };
    await drawAt(a, 300, 310);
    const aAfterOwn = await picture(a);
    const bBeforeOwn = await picture(b);
    await drawAt(b, 320, 320);
    await expect.poll(() => picture(b), { timeout: 2000, intervals: [50, 100, 200],
      message: "B must render A's element even though B also has unsaved work" }).not.toBe(bBeforeOwn);
    await expect.poll(() => picture(a), { timeout: 2000, intervals: [50, 100, 200],
      message: "A must render B's element while A itself has unsaved changes" }).not.toBe(aAfterOwn);
    const unchanged = await picture(control);
    let navigations = 0;
    b.on("framenavigated", frame => { if (frame === b.mainFrame()) navigations++; });
    await a.locator(".excalidraw__canvas.interactive").click({ position: { x: 340, y: 340 } });
    await a.keyboard.press("Control+a");
    await a.keyboard.press("Backspace");
    await a.mouse.move(10, 10);
    const saved = await save(a);
    const savedElements = saved.request().postDataJSON().elements;
    expect(savedElements.filter((element) => !element.isDeleted), "everything drawn is deleted").toEqual([]);
    expect(savedElements.find((element) => element.id === "shared-shape"),
      "the shared shape is deleted").toMatchObject({ isDeleted: true });
    // Two seconds is a realtime deadline, not a manual refresh/polling cycle.
    await expect.poll(() => picture(b), { timeout: 2000, intervals: [50, 100, 200],
      message: "A's saved deletion must become visible in B's already-open canvas within 2s without reload" }).toBe(blank);
    expect(navigations, "B must not navigate or reload to receive the saved scene").toBe(0);
    expect(await picture(control), "A's deletion must not affect B's unrelated open diagram").toBe(unchanged);
    expect(errors, "Neither user's pages may emit uncaught page errors").toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
  expect(errors, "No uncaught page errors during context cleanup").toEqual([]);
});
