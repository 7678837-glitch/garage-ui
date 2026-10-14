import { assertAuthenticated, chooseTheme, openAccount, openDisclosure } from "./interactions";
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
    await page.getByLabel("Current password").fill(administrator.password);
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
    await expect(page.getByRole("button", { name: "Create bucket", exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Keys", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Keys" })).toBeVisible();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create key", exact: true })).toBeVisible();

    await nav.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await openDisclosure(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }).locator("summary", { hasText: "Edit" }));
    const download = page.getByRole("checkbox", {
      name: `Download for ${readOnlyUser.username}`,
    });
    const share = page.getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` });
    await download.click();
    await expect(download).toBeChecked();
    await expect(share).toBeEnabled();
    await share.click();
    await expect(share).toBeChecked();

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
    await openDisclosure(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }).locator("summary", { hasText: "Edit" }));
    await expect(
      users.getByRole("checkbox", { name: `Download for ${readOnlyUser.username}` }),
    ).toBeChecked();
    await expect(
      users.getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` }),
    ).toBeChecked();
    await recordLayout(page, "account-users");

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
    await openDisclosure(page.getByRole("region", { name: "Users" }).locator("tbody tr", { hasText: readOnlyUser.username }).locator("summary", { hasText: "Edit" }));
    const share = page.getByRole("checkbox", { name: `Share for ${readOnlyUser.username}` });
    const download = page.getByRole("checkbox", { name: `Download for ${readOnlyUser.username}` });
    await share.click();
    await expect(share).not.toBeChecked();
    await download.click();
    await expect(download).not.toBeChecked();
    await sections(page).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await page.getByLabel("Current password").fill(nextPassword);
    await page.getByLabel("New password").fill(administrator.password);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password updated", { exact: true })).toBeVisible();
  });
});
