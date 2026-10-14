import { assertAuthenticated, chooseTheme, openAccount, openRowActions } from "./interactions";
import { expect, type Page, type Route, test } from "@playwright/test";
import { administrator, readOnlyUser } from "./accounts";
import { evidenceDir, recordLayout } from "./layout";

const nextPassword = "e2e-admin-next";

const viewerLinks = ["Overview", "Buckets", "Keys", "Settings"] as const;

const hiddenLinks = [
  "Create bucket",
  "Create key",
  "Nodes and layout",
  "Workers",
  "Block errors",
  "Audit",
  "Admin tokens",
  "Users",
] as const;

type UserListMode = "live" | "empty" | "error";

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

async function logOut(page: Page): Promise<void> {
  await sections(page).getByRole("link", { name: "Overview", exact: true }).click();
  await openAccount(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
}

function isUserList(route: Route): boolean {
  if (route.request().method() !== "GET") {
    return false;
  }
  return new URL(route.request().url()).pathname === "/api/users";
}

test.describe.serial("accounts", () => {
  // Serial tests can skip the final UI restoration after a failure; teardown must still restore shared accounts.
  test.afterAll(async ({ playwright }, testInfo) => {
    test.setTimeout(120_000);
    const cleanup = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL, timeout: 10_000 });
    try {
      let password = administrator.password;
      let login = await cleanup.post("/api/auth/login", { data: { username: administrator.username, password } });
      if (login.status() === 401) {
        expect(await login.json()).toMatchObject({ code: "invalid_credentials" });
        password = nextPassword;
        login = await cleanup.post("/api/auth/login", { data: { username: administrator.username, password } });
      }
      expect(login.status(), "Account cleanup login").toBe(200);
      const csrf = (await cleanup.storageState()).cookies.find((cookie) => cookie.name === "garage_csrf")?.value;
      expect(csrf, "Account cleanup CSRF cookie").toBeTruthy();
      const headers = { "x-csrf-token": decodeURIComponent(csrf ?? "") };
      try {
        const response = await cleanup.get("/api/users?offset=0&limit=100");
        expect(response.status(), "Account cleanup user list").toBe(200);
        const users = await response.json() as { items: { id: number; username: string; can_download: boolean; can_share: boolean }[] };
        const viewer = users.items.find((user) => user.username === readOnlyUser.username);
        if (!viewer) throw new Error("Account cleanup could not find the read-only user");
        if (viewer.can_download || viewer.can_share) {
          const restored = await cleanup.patch(`/api/users/${viewer.id}`, { headers, data: { can_download: false, can_share: false } });
          expect(restored.status(), "Account cleanup viewer permissions").toBe(200);
          expect(await restored.json()).toMatchObject({ can_download: false, can_share: false });
        }
      } finally {
        if (password === nextPassword) {
          const restored = await cleanup.post("/api/auth/change-password", {
            headers, data: { current_password: nextPassword, new_password: administrator.password },
          });
          expect(restored.status(), "Account cleanup administrator password").toBe(200);
          const verified = await cleanup.post("/api/auth/login", { data: administrator });
          expect(verified.status(), "Restored administrator can log in").toBe(200);
        }
      }
    } finally {
      await cleanup.dispose();
    }
  });
  test("hides write entries from a read-only account", async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, readOnlyUser.username, readOnlyUser.password);
    const nav = sections(page);
    for (const name of viewerLinks) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }
    for (const name of hiddenLinks) {
      await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
    }
  });

  test("changes the administrator password on Settings", async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, administrator.username, administrator.password);
    const nav = sections(page);
    for (const name of hiddenLinks) {
      if (name === "Create bucket" || name === "Create key") {
        continue;
      }
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    const currentPassword = page.getByLabel("Current password");
    const field = currentPassword.locator("..");
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    if (!box) throw new Error("Current password field has no visible hit target");
    expect(box.height, "Phone TextField wrapper hit target").toBeGreaterThanOrEqual(36);
    expect(await currentPassword.evaluate((input) => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await field.evaluate((wrapper) => {
      const bounds = wrapper.getBoundingClientRect();
      return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 0.5) === wrapper;
    }), "TextField border press targets the wrapper").toBe(true);
    await field.click({ position: { x: box.width / 2, y: 0.5 } });
    await expect(currentPassword, "TextField border press focuses the input").toBeFocused();
    await page.setViewportSize({ width: 1280, height: 800 });
    await currentPassword.fill(administrator.password);
    await page.getByLabel("New password").fill(nextPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password updated", { exact: true })).toBeVisible();
    await logOut(page);
    await logIn(page, administrator.username, nextPassword);
  });

  test("keeps create controls hidden after download and share", async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, administrator.username, nextPassword);
    const nav = sections(page);
    await nav.getByRole("link", { name: "Buckets", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Buckets" })).toBeVisible();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const bucketCreator = page.getByRole("dialog", { name: "Create bucket", exact: true });
    await expect(bucketCreator.getByRole("button", { name: "Create bucket", exact: true })).toBeVisible();
    await bucketCreator.getByRole("button", { name: "Cancel", exact: true }).click();
    await nav.getByRole("link", { name: "Keys", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Keys" })).toBeVisible();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const keyCreator = page.getByRole("dialog", { name: "Create key", exact: true });
    await expect(keyCreator.getByRole("button", { name: "Create key", exact: true })).toBeVisible();
    await keyCreator.getByRole("button", { name: "Cancel", exact: true }).click();

    await nav.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await openRowActions(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }));
    const download = page.getByRole("checkbox", {
      name: `Download for ${readOnlyUser.username}`,
    });
    const share = page.getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` });
    await download.click();
    await expect(download).toBeChecked();
    await expect(share).toBeEnabled();
    await share.click();
    await expect(share).toBeChecked();

    await page.getByRole("dialog", { name: readOnlyUser.username, exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await logOut(page);
    await logIn(page, readOnlyUser.username, readOnlyUser.password);
    const viewerNav = sections(page);
    await viewerNav.getByRole("link", { name: "Buckets", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Buckets" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create bucket", exact: true })).toHaveCount(0);
    await viewerNav.getByRole("link", { name: "Keys", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Keys" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create key", exact: true })).toHaveCount(0);
  });

  test("records the users page, including an empty list and a retry", async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, administrator.username, nextPassword);
    await sections(page).getByRole("link", { name: "Users", exact: true }).click();
    const users = page.getByRole("region", { name: "Users" });
    await expect(users.getByRole("heading", { name: "Users" })).toBeVisible();
    await openRowActions(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }));
    await expect(
      page.getByRole("dialog", { name: readOnlyUser.username, exact: true }).getByRole("checkbox", { name: `Download for ${readOnlyUser.username}` }),
    ).toBeChecked();
    await expect(
      page.getByRole("dialog", { name: readOnlyUser.username, exact: true }).getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` }),
    ).toBeChecked();
    await recordLayout(page, "account-users");

    await page.getByRole("dialog", { name: readOnlyUser.username, exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await chooseTheme(page, "Light");
    await page.screenshot({ path: `${evidenceDir}/account-users-light.png`, fullPage: true });
    await chooseTheme(page, "Dark");
    await page.screenshot({ path: `${evidenceDir}/account-users-dark.png`, fullPage: true });

    let mode: UserListMode = "live";
    await page.route("**/api/users?*", async (route) => {
      if (!isUserList(route) || mode === "live") {
        await route.continue();
        return;
      }
      if (mode === "empty") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], hasMore: false }),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "users_unavailable", message: "Users are unavailable" }),
      });
    });

    mode = "empty";
    await page.reload();
    await expect(users.getByText("There are no users. Create the first user.")).toBeVisible();

    mode = "error";
    await page.reload();
    await expect(users.getByText("Users are unavailable", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(users.getByText("users_unavailable", { exact: true })).toBeVisible();
    const retry = users.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();

    mode = "live";
    await retry.click();
    await expect(users.getByRole("cell", { name: readOnlyUser.username, exact: true })).toBeVisible();
    await expect(users.getByText("There are no users. Create the first user.")).toHaveCount(0);
    await expect(users.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  });

  test("restores the administrator password and viewer permissions", async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, administrator.username, nextPassword);
    await sections(page).getByRole("link", { name: "Users", exact: true }).click();
    await openRowActions(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }));
    const share = page.getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` });
    const download = page.getByRole("checkbox", { name: `Download for ${readOnlyUser.username}` });
    await share.click();
    await expect(share).not.toBeChecked();
    await download.click();
    await expect(download).not.toBeChecked();
    await page.getByRole("dialog", { name: readOnlyUser.username, exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await sections(page).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await page.getByLabel("Current password").fill(nextPassword);
    await page.getByLabel("New password").fill(administrator.password);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password updated", { exact: true })).toBeVisible();
  });
});
