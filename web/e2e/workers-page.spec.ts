import { submitLogin } from "./login";
import { assertAuthenticated } from "./interactions";
import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

function watchRepair(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/repair")) {
      seen.push(url);
    }
  });
  return seen;
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
  await assertAuthenticated(page);
}

test("opens workers for one live node without starting repair", async ({ page }) => {
  test.setTimeout(120_000);
  const repair = watchRepair(page);

  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Nodes and layout", exact: true })
    .click();
  const cluster = page.getByRole("region", { name: "Cluster nodes" });
  await expect(cluster.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(cluster.getByLabel("Loading nodes")).toHaveCount(0, { timeout: 20_000 });
  const nodeCard = cluster
    .locator("tbody tr")
    .filter({
      has: page.getByText("Up", { exact: true }).or(page.getByText("Down", { exact: true })),
    })
    .first();
  await expect(nodeCard).toBeVisible();
  const nodeHref = await nodeCard.locator('a[href^="#node/"]').first().getAttribute("href");
  const nodeId = decodeURIComponent(nodeHref?.split("/")[1] ?? "");
  expect(nodeId.length).toBeGreaterThan(0);

  await page.goto(`/#workers/${encodeURIComponent(nodeId)}`);
  const workers = page.getByRole("region", { name: "Workers" });
  await expect(workers.getByRole("heading", { name: "Workers" })).toBeVisible();
  await expect(workers.getByText("No node is selected")).toHaveCount(0);
  const row = workers
    .locator("tbody tr")
    .filter({ has: page.getByRole("button", { name: /^Details \d+: / }) })
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator("td").first()).not.toHaveText(/^\s*$/);
  await expect(row.getByRole("button", { name: /^Details \d+: / })).toBeVisible();
  expect(repair, `repair requests: ${repair.join(" ")}`).toEqual([]);

  await assertWidth(page, "workers-page", 1280);
  await assertWidth(page, "workers-page", 360);
  await expect(row).toBeVisible();
  await expect(workers.getByText("No node is selected")).toHaveCount(0);
  expect(repair, `repair requests: ${repair.join(" ")}`).toEqual([]);
});

for (const width of [360, 1280]) {
  test(`all-node partial failure stays visible without repair completion at ${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 800 });
    await logIn(page);
    const message = "1 node succeeded; 1 node failed: n2. Successful nodes may have applied the operation. Check failed nodes before retrying. Do not automatically retry the whole operation.";
    const failure = {
      code: "garage_partial_failure", message,
      success: { n1: [] }, error: { n2: "rpc timeout" },
    };
    const workersEndpoint = /\/api\/nodes\/(?:\*|%2A)\/workers$/;
    await page.route(workersEndpoint, async (route) => {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify(failure) });
    });
    await page.goto("/#workers/*");
    const workers = page.getByRole("region", { name: "Workers" });
    await expect(workers.getByText(message, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(workers.getByText("garage_partial_failure", { exact: true })).toBeVisible();
    await expect(workers.getByText("There are no workers.")).toHaveCount(0);
    await assertWidth(page, "workers-partial-list", width);

    await page.unroute(workersEndpoint);
    await workers.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(workers.getByText("garage_partial_failure", { exact: true })).toHaveCount(0, { timeout: 20_000 });
    await expect(workers.getByRole("button", { name: /^Details \d+: / }).first()).toBeVisible();
    let repairs = 0;
    await page.route(/\/api\/nodes\/(?:\*|%2A)\/repair$/, async (route) => {
      repairs += 1;
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ...failure, success: { n1: null } }) });
    });
    await workers.locator("summary").filter({ hasText: "Maintenance" }).click();
    await workers.getByRole("button", { name: "Start repair", exact: true }).click();
    await page.getByRole("dialog", { name: "Start repair", exact: true }).getByRole("button", { name: "Start repair", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm *", exact: true });
    await confirmation.getByLabel("Type * to confirm", { exact: true }).fill("*");
    await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(confirmation.getByText(message, { exact: false })).toBeVisible();
    await expect(confirmation).toBeVisible();
    await expect(page.getByText("Repair started.", { exact: true })).toHaveCount(0);
    await assertWidth(page, "workers-partial-repair", width);
    expect(repairs).toBe(1);
  });
}
