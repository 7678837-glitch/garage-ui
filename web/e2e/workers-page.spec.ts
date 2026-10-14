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
