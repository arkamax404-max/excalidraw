import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const { test, expect } = createRequire(process.argv[1])("playwright/test");

const scene = {
  type: "excalidraw", version: 2, elements: [],
  appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  files: {},
};

const login = async (page, username) => {
  page.setDefaultTimeout(10000);
  await page.goto("/");
  await page.getByRole("textbox", { name: "Usuario", exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar u ocultar panel" }).click();
  await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
};

const rowFor = (page, name) => page.locator("li.file-row button.file-button").filter({
  has: page.locator(".file-name", { hasText: new RegExp(`^${name}\\.excalidraw\\.json$`) }),
});

test("owner shares a loaded diagram from the panel and the member sees it", async ({ browser, baseURL }) => {
  test.setTimeout(40000);
  const contexts = [];
  const errors = [];
  try {
    for (let i = 0; i < 2; i++) contexts.push(await browser.newContext({ baseURL }));
    for (const context of contexts) {
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    }
    const owner = await contexts[0].newPage();
    const member = await contexts[1].newPage();
    await login(owner, "owner");
    await login(member, "member");

    const name = `share-${randomUUID()}`;
    const seeded = await owner.request.put(`/api/files/${name}`, { data: scene, timeout: 10000 });
    expect(seeded.status()).toBe(200);

    await owner.getByRole("button", { name: "Recargar", exact: true }).click();
    await expect(rowFor(owner, name)).toHaveCount(1, { timeout: 10000 });
    await rowFor(owner, name).click();

    // Sharing is offered only for a diagram this user owns and has loaded.
    const userInput = owner.getByRole("textbox", { name: "Usuario para compartir" });
    await expect(userInput).toBeVisible();
    await expect(owner.getByRole("button", { name: "Compartir", exact: true })).toBeDisabled();
    await userInput.fill("member");
    await owner.getByRole("button", { name: "Compartir", exact: true }).click();
    await expect(owner.locator(".status")).toContainText("ya puede abrir este diagrama.");
    await expect(owner.locator("li.file-row .file-name", { hasText: /^member$/ })).toHaveCount(1);

    await member.getByRole("button", { name: "Recargar", exact: true }).click();
    const sharedRow = member.locator("li.file-row").filter({
      has: member.locator(".file-name", { hasText: new RegExp(`^${name}\\.excalidraw\\.json$`) }),
    });
    await expect(sharedRow, "the shared diagram reaches the member's list").toHaveCount(1, { timeout: 10000 });
    await expect(sharedRow).toContainText("Compartido");
    // A member cannot delete someone else's diagram, and cannot share it onward.
    await expect(sharedRow.locator(".file-delete-button")).toHaveCount(0);
    await sharedRow.locator("button.file-button").click();
    await expect(member.locator(".status")).toContainText("cargado.");
    // The row stays visible so sharing is discoverable, but a member learns why
    // it is unusable instead of the control vanishing or claiming authority.
    await expect(member.getByRole("textbox", { name: "Usuario para compartir" })).toBeDisabled();
    await expect(member.getByRole("button", { name: "Compartir", exact: true })).toBeDisabled();
    await expect(member.getByRole("button", { name: "Accesos", exact: true })).toBeDisabled();
    await expect(member.locator(".share-hint"))
      .toHaveText("Carga un diagrama tuyo para compartirlo.");

    expect(errors, "Neither page may emit uncaught errors").toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
