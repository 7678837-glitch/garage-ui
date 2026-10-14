import { assertAuthenticated, bucketIdFromRow, openDisclosure, openRowActions } from "./interactions";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

test("saves one CORS rule and one lifecycle rule on a new bucket", async ({ page }) => {
  test.setTimeout(180_000);
  const alias = `e2e-301-${Date.now().toString(36)}`;
  try {
    await logIn(page);
    await openBuckets(page);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByLabel("Global alias", { exact: true }).fill(alias);
    await page.getByRole("button", { name: "Create bucket", exact: true }).click();
    await expect(page.getByText("Bucket created", { exact: true })).toBeVisible({ timeout: 20_000 });

    const buckets = page.getByRole("region", { name: "Buckets" });
    await expect(async () => {
      if ((await buckets.getByText(alias, { exact: true }).count()) === 0) {
        await page.reload();
        await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
      }
      await expect(buckets.getByText(alias, { exact: true })).toBeVisible();
    }).toPass({ timeout: 30_000 });
    await buckets.getByLabel("Filter buckets").fill(alias);
    const row = await revealRow(buckets, alias);
    await expect(row.getByText(alias, { exact: true })).toBeVisible();
    const bucketId = await bucketIdFromRow(row);

    await openDisclosure(row.locator("summary[aria-label^=\"Edit \"]"));
    await row.getByRole("button", { name: "Edit CORS", exact: true }).click();
    await row.getByRole("button", { name: "Add CORS rule", exact: true }).click();
    await row.getByLabel("ID").fill("photos");
    await row.getByLabel("AllowedOrigin").fill("https://photos.example");
    await row.getByLabel("AllowedMethod").fill("GET");
    await row.getByRole("button", { name: "Review CORS", exact: true }).click();
    await expect(row.getByRole("button", { name: "Save CORS", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await saveRule(page, row, "Save CORS", "/cors");
    await expect(row.getByLabel("AllowedOrigin")).toHaveValue("https://photos.example");
    const cors = await page.request.get(`/api/buckets/${bucketId}/cors`);
    expect(cors.ok(), "Saved CORS must be readable").toBe(true);
    expect(await cors.json()).toMatchObject({
      corsRules: [{ ID: "photos", AllowedOrigin: ["https://photos.example"], AllowedMethod: ["GET"] }],
    });

    await row.getByRole("button", { name: "Edit lifecycle", exact: true }).click();
    await row.getByRole("button", { name: "Add lifecycle rule", exact: true }).click();
    await row.getByLabel("ID").nth(1).fill("expire");
    await row.getByLabel("Status").fill("Enabled");
    await row.getByLabel("Expiration.Days").fill("7");
    await row.getByRole("button", { name: "Review lifecycle", exact: true }).click();
    await expect(row.getByRole("button", { name: "Save lifecycle", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByLabel("Next")).toContainText('"Days":7');
    await saveRule(page, row, "Save lifecycle", "/lifecycle");
    await expect(row.getByLabel("Expiration.Days")).toHaveValue("7");
    const lifecycle = await page.request.get(`/api/buckets/${bucketId}/lifecycle`);
    expect(lifecycle.ok(), "Saved lifecycle must be readable").toBe(true);
    expect(await lifecycle.json()).toMatchObject({
      lifecycleRules: [{ ID: "expire", Status: "Enabled", Expiration: { Days: 7 } }],
    });

    await assertWidth(page, "bucket-editor", 1280);
    await assertWidth(page, "bucket-editor", 360);
  } finally {
    await cleanup(page, alias);
  }
});

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

async function openBuckets(page: Page): Promise<void> {
  const link = page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
    name: "Buckets",
    exact: true,
  });
  if (!(await link.isVisible())) {
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if ((await menu.count()) > 0 && (await menu.getAttribute("aria-expanded")) !== "true") {
      await menu.click();
    }
  }
  await link.click();
  await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
}

async function revealRow(scope: Locator, text: string): Promise<Locator> {
  const row = scope.locator("tbody tr", { hasText: text });
  await expect(async () => {
    if ((await row.count()) > 0) {
      return;
    }
    const more = scope.getByRole("button", { name: "Load more", exact: true });
    if (await more.isVisible()) {
      await more.click();
    }
    expect(await row.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  return row.first();
}

async function saveRule(
  page: Page,
  row: Locator,
  name: "Save CORS" | "Save lifecycle",
  path: "/cors" | "/lifecycle",
): Promise<void> {
  const pending = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "PUT" && new URL(request.url()).pathname.endsWith(path);
  });
  await row.getByRole("button", { name, exact: true }).click();
  const response = await pending;
  const body = await response.text();
  expect(response.ok(), `${name} returned ${response.status()} ${body}`).toBe(true);
}

async function cleanup(page: Page, alias: string): Promise<void> {
  if (page.isClosed()) {
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await openBuckets(page);
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await buckets.getByLabel("Filter buckets").fill(alias);
  for (let guard = 0; guard < 5; guard += 1) {
    const row = buckets.locator("tbody tr", { has: page.getByText(alias, { exact: true }) });
    if ((await row.count()) === 0) {
      const more = buckets.getByRole("button", { name: "Load more", exact: true });
      if (await more.isVisible()) {
        await more.click();
        continue;
      }
      return;
    }
    const target = row.first();
    await expect(target.getByText(alias, { exact: true })).toBeVisible();
    const bucketId = await bucketIdFromRow(target);
    console.log("bucket-editor cleanup", JSON.stringify({ alias, bucketId }));
    await openRowActions(target);
    await target.getByRole("button", { name: `Delete ${bucketId}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete bucket", exact: true }).click();
    await expect(buckets.getByText(alias, { exact: true })).toHaveCount(0, { timeout: 20_000 });
  }
}
