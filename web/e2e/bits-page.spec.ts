import { openDisclosure } from "./interactions";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const password = "e2e-298-pass";

let username = "";
let created = false;

function usersRegion(page: Page): Locator {
  return page.getByRole("region", { name: "Users" });
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

async function openUsers(page: Page): Promise<Locator> {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible().catch(() => false)) {
    if ((await menu.getAttribute("aria-expanded")) !== "true") {
      await menu.click();
    }
  }
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Users", exact: true })
    .click();
  const users = usersRegion(page);
  await expect(users.getByRole("heading", { name: "Users" })).toBeVisible();
  return users;
}

async function revealDownload(page: Page, name: string): Promise<Locator> {
  const users = usersRegion(page);
  await users.getByLabel("Filter users").fill(name);
  const download = users.getByRole("checkbox", {
    name: `Download for ${name}`,
    exact: true,
  });
  const next = users.getByRole("button", { name: "Next", exact: true });
  for (let step = 0; step < 20; step += 1) {
    await expect(users.getByLabel("Loading users")).toHaveCount(0);
    const row = users.locator("tbody tr", { hasText: name });
    if (await row.count() === 1) await openDisclosure(row.locator("summary", { hasText: "Edit" }));
    if (await download.isVisible().catch(() => false)) {
      return download;
    }
    if (await next.isDisabled().catch(() => true)) {
      break;
    }
    await next.click();
  }
  await expect(download).toBeVisible();
  return download;
}

test.afterEach(async ({ page }) => {
  if (!created || page.isClosed()) {
    return;
  }
  const users = usersRegion(page);
  if (!(await users.isVisible().catch(() => false))) {
    await openUsers(page);
  }
  await users.getByLabel("Filter users").fill(username);
  const remove = users.getByRole("button", { name: `Delete ${username}`, exact: true });
  const next = users.getByRole("button", { name: "Next", exact: true });
  for (let step = 0; step < 20; step += 1) {
    await expect(users.getByLabel("Loading users")).toHaveCount(0);
    if (await remove.isVisible().catch(() => false)) {
      break;
    }
    if (await next.isDisabled().catch(() => true)) {
      break;
    }
    await next.click();
  }
  if (!(await remove.isVisible().catch(() => false))) {
    return;
  }
  await remove.click();
  await expect(users.getByRole("cell", { name: username, exact: true })).toHaveCount(0);
});

test("keeps download unchecked for a viewer after revoke and reload", async ({ page }) => {
  test.setTimeout(120_000);
  username = `e2e-298-${Date.now().toString(36)}`;
  await logIn(page);
  const users = await openUsers(page);
  await openDisclosure(users.locator("summary", { hasText: "Create user" }));
  const form = users.getByRole("form", { name: "Create user" });
  await form.getByLabel("Username").fill(username);
  await form.getByLabel("Password").fill(password);
  await form.getByLabel("Role").selectOption("viewer");
  const formDownload = form.getByRole("checkbox", { name: "Download", exact: true });
  const formShare = form.getByRole("checkbox", { name: "Share", exact: true });
  await formDownload.check();
  await expect(formShare).not.toBeChecked();

  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/users";
  });
  await form.getByRole("button", { name: "Create user", exact: true }).click();
  created = true;
  const response = await createdResponse;
  const createdBody: unknown = await response.json();
  expect(response.status()).toBe(201);
  expect(createdBody).toMatchObject({
    username,
    role: "viewer",
    can_download: true,
    can_share: false,
  });

  const download = await revealDownload(page, username);
  const share = users.getByRole("checkbox", { name: `Share for ${username}`, exact: true });
  await expect(download).toBeChecked();
  await expect(share).not.toBeChecked();

  const revoked = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH" && /^\/api\/users\/\d+$/.test(url.pathname);
  });
  await download.click();
  const patched = await revoked;
  const patchedBody: unknown = await patched.json();
  expect(patched.ok()).toBe(true);
  expect(patchedBody).toMatchObject({ can_download: false, can_share: false });
  await expect(download).not.toBeChecked();
  await expect(share).not.toBeChecked();

  await page.reload();
  await expect(usersRegion(page).getByRole("heading", { name: "Users" })).toBeVisible();
  const persisted = await revealDownload(page, username);
  await expect(persisted).not.toBeChecked();
  await expect(
    usersRegion(page).getByRole("checkbox", { name: `Share for ${username}`, exact: true }),
  ).not.toBeChecked();

  await assertWidth(page, "users-bits", 1280);
  await assertWidth(page, "users-bits", 360);
});
