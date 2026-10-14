import { assertAuthenticated } from "./interactions";
import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

test("nodes page stays within the viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Nodes and layout", exact: true })
    .click();
  const nodes = page.getByRole("region", { name: "Cluster nodes" });
  await expect(nodes.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(nodes.getByLabel("Loading nodes")).toHaveCount(0, { timeout: 20_000 });
  await expect(
    nodes
      .getByText("Up", { exact: true })
      .or(nodes.getByText("Down", { exact: true }))
      .or(nodes.getByText("There are no nodes. Connect the first node.")),
  ).toBeVisible();

  await assertWidth(page, "nodes-page", 1280);
  await assertWidth(page, "nodes-page", 360);
});
