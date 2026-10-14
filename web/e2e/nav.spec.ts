import { assertAuthenticated, openAccount } from "./interactions";
import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth, recordLayout } from "./layout";

const deliveredSections = [
  "Overview",
  "Buckets",
  "Keys",
  "Nodes and layout",
  "Workers",
  "Block errors",
  "Audit",
  "Admin tokens",
  "Users",
  "Settings",
] as const;

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

async function logIn(page: Page): Promise<void> {
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

async function expectSections(page: Page, visible: boolean): Promise<void> {
  const nav = sections(page);
  for (const name of deliveredSections) {
    const link = nav.getByRole("link", { name, exact: true });
    if (visible) {
      await expect(link).toBeVisible();
    } else {
      await expect(link).toHaveCount(0);
    }
  }
}

let createdBucketId = "";

test.afterEach(async ({ page }) => {
  if (createdBucketId.length === 0) {
    return;
  }
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  const response = await page.request.delete(`/api/buckets/${createdBucketId}`, {
    headers: { "x-csrf-token": csrf },
  });
  expect(response.ok(), `cleanup bucket failed with status ${response.status()}`).toBe(true);
});

test("logs in, collapses the narrow menu, and opens objects", async ({ page }) => {
  createdBucketId = "";
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await recordLayout(page, "login");

  await logIn(page);
  await expectSections(page, true);
  await recordLayout(page, "overview");

  await sections(page).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await recordLayout(page, "about");

  await sections(page).getByRole("link", { name: "Overview", exact: true }).click();
  await openAccount(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await recordLayout(page, "logged-out");

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await logIn(page);
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  await expectSections(page, false);
  await assertWidth(page, "menu-collapsed", 360);

  await page.getByRole("button", { name: "Menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Sections", exact: true });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu", includeHidden: true })).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await expectSections(page, true);
  await assertWidth(page, "menu-expanded", 360);

  await drawer.getByRole("button", { name: "Close navigation", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
  await expectSections(page, false);

  let releaseSnapshot!: () => void;
  let markSnapshot!: () => void;
  const snapshotCaptured = new Promise<void>((resolve) => { markSnapshot = resolve; });
  const snapshotReleased = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let delayed = false;
  await page.route(/\/api\/buckets\?/, async (route) => {
    if (delayed) {
      await route.continue();
      return;
    }
    delayed = true;
    const response = await route.fetch();
    markSnapshot();
    await snapshotReleased;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Menu" }).click();
  await sections(page).getByRole("link", { name: "Buckets", exact: true }).click();
  await snapshotCaptured;
  await expect(page.getByRole("heading", { name: "Buckets" })).toBeVisible();
  const alias = `e2e-252-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  const createdResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/buckets",
  );
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  const body: unknown = await created.json();
  expect(body).toHaveProperty("id");
  createdBucketId = String((body as { id: unknown }).id);
  expect(createdBucketId).toMatch(/^[0-9a-f]{64}$/);
  releaseSnapshot();
  const creator = page.getByRole("dialog", { name: "Create bucket", exact: true });
  await expect(creator.getByText("Bucket created", { exact: true })).toBeVisible();
  await creator.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(creator).toHaveCount(0);
  await expect(page.getByText(alias, { exact: true })).toBeVisible();
  await recordLayout(page, "buckets");

  await page
    .locator("tr", { hasText: alias })
    .getByRole("button", { name: /^Open objects \(/ })
    .click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true })).toBeVisible();
  await expect.soft(page.getByText("Global alias")).toHaveCount(0);
  await expect.soft(page.getByText("Create bucket")).toHaveCount(0);
  await recordLayout(page, "objects");
});
