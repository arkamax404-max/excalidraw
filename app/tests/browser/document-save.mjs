// Run with the installed Playwright CLI and an isolated fixture, never a real account.
import { createRequire } from "node:module";
const { test, expect } = createRequire(process.argv[1])("playwright/test");

const login = async (page) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Usuario", exact: true }).fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
};
const name = page => page.getByRole("textbox", { name: "Nombre del diagrama" });
const load = async (page, target) => {
  await page.getByRole("button", { name: new RegExp(`^${target}\\.excalidraw\\.json`) }).click();
  await expect(page.locator(".status")).toContainText("cargado.");
};
const save = async (page) => {
  const response = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/api/files/"));
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const result = await response;
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
  return result;
};
const draw = async (page, x) => {
  await page.locator(".excalidraw__canvas.interactive").click({ position: { x: 200, y: 200 } });
  await page.keyboard.press("r");
  await page.mouse.move(x, 400);
  await page.mouse.down();
  await page.mouse.move(x + 100, 480, { steps: 4 });
  await page.mouse.up();
};

test("guarded saves, save-as, conflict retention, reload and identity invalidation", async ({ page, browser }, testInfo) => {
  await login(page);
  const scene = { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} };
  const seeded = await page.request.put("/api/files/existing", { data: scene });
  expect(seeded.status()).toBe(200);
  await page.getByRole("button", { name: "Recargar", exact: true }).click();
  await load(page, "existing");
  await draw(page, 350);
  const first = await save(page);
  expect(first.request().headers()["if-match"]).toBe(seeded.headers().etag);
  expect(first.headers().etag).toMatch(/:2"$/);
  const second = await save(page);
  expect(second.request().headers()["if-match"]).toBe(first.headers().etag);
  expect(second.headers().etag).toMatch(/:3"$/);
  await name(page).fill(" Fresh Name ");
  const fresh = await save(page);
  expect(fresh.status()).toBe(200);
  expect(fresh.request().headers()["if-match"]).toBeUndefined();
  await expect(name(page)).toHaveValue("fresh-name");
  const freshAgain = await save(page);
  expect(freshAgain.request().headers()["if-match"]).toBe(fresh.headers().etag);

  const otherContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width: 1400, height: 1000 } });
  const other = await otherContext.newPage();
  try {
    await login(other);
    await load(other, "existing");
    await load(page, "existing");
    await draw(other, 550);
    const winner = await save(page);
    expect(winner.status()).toBe(200);
    const loser = await save(other);
    expect(loser.status()).toBe(412);
    await expect(other.locator(".status")).toContainText("Tu dibujo sigue intacto");
    const retained = loser.request().postDataJSON();
    expect(retained.elements.filter(e => !e.isDeleted).length).toBeGreaterThan(1);
    await name(other).fill("retained-copy");
    const copy = await save(other);
    expect(copy.status()).toBe(200);
    expect(copy.request().postDataJSON().elements).toEqual(retained.elements);
    let gets = 0;
    const countGets = request => { if (request.method() === "GET" && request.url().endsWith("/api/files/existing")) gets++; };
    other.on("request", countGets);
    await name(other).fill("existing");
    const unknown = await save(other);
    expect(unknown.status()).toBe(428);
    expect(gets).toBe(0);
    expect(unknown.request().headers()["if-match"]).toBeUndefined();
    expect(unknown.request().postDataJSON().elements).toEqual(retained.elements);
    other.off("request", countGets);
    await load(other, "existing");
    const reloaded = await save(other);
    expect(reloaded.request().headers()["if-match"]).toBe(winner.headers().etag);
    await other.getByRole("button", { name: "Nuevo", exact: true }).click();
    await name(other).fill("existing");
    expect((await save(other)).status()).toBe(428);
    await other.getByRole("button", { name: "Logout", exact: true }).click();
    await login(other);
    await name(other).fill("existing");
    const afterLogin = await save(other);
    expect(afterLogin.status()).toBe(428);
    expect(afterLogin.request().headers()["if-match"]).toBeUndefined();
    await other.screenshot({ path: testInfo.outputPath("conflict.png") });
  } finally {
    await otherContext.close();
  }
  // A completed canonical save must not rename a different document while its ack is delayed.
  let release, fetched;
  const held = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { fetched = resolve; });
  await page.route("**/api/files/existing", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response });
  });
  await load(page, "existing");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await received;
  await name(page).fill("late-copy");
  release();
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled();
  await expect(name(page)).toHaveValue("late-copy");
  await page.unroute("**/api/files/existing");
  const lateCopy = await save(page);
  expect(lateCopy.status()).toBe(200);
  expect(lateCopy.request().headers()["if-match"]).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath("saved.png") });
});
