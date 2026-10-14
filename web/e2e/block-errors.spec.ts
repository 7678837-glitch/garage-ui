import { assertAuthenticated } from "./interactions";
import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

function watchBlockMutations(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/blocks/purge") || url.includes("/blocks/retry")) {
      seen.push(url);
    }
  });
  return seen;
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

test("opens Block errors for one live node without purging or retrying", async ({ page }) => {
  test.setTimeout(120_000);
  const mutations = watchBlockMutations(page);

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
  const nodeId = ((await nodeCard.locator("[title]").first().getAttribute("title")) ?? "").trim();
  expect(nodeId.length).toBeGreaterThan(0);

  await page.goto(`/#block-errors/${encodeURIComponent(nodeId)}`);
  const blockErrors = page.getByRole("region", { name: "Block errors" });
  await expect(blockErrors.getByRole("heading", { name: "Block errors" })).toBeVisible();
  await expect(blockErrors.getByText("No node is selected")).toHaveCount(0);
  const empty = blockErrors.getByText("There are no block errors.", { exact: true });
  const errorRow = blockErrors.locator("tbody tr");
  await expect(empty.or(errorRow.first())).toBeVisible({ timeout: 20_000 });
  const listed = (await errorRow.count()) > 0;
  console.log(listed ? "block errors: listed" : "block errors: empty");

  expect(mutations, `block mutation requests: ${mutations.join(" ")}`).toEqual([]);
  await assertWidth(page, "block-errors", 1280);
  await assertWidth(page, "block-errors", 360);
  await expect(blockErrors.getByText("No node is selected")).toHaveCount(0);
  await expect(empty.or(errorRow.first())).toBeVisible();
  expect(mutations, `block mutation requests: ${mutations.join(" ")}`).toEqual([]);
});
