import { assertAuthenticated } from "./interactions";
import { expect, type Locator, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const metricLabels = ["S3 requests", "S3 errors", "Block read bytes", "Block write bytes"] as const;

test("shows S3 and block byte counts on Cluster health", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);

  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();

  const health = page.getByRole("region", { name: "Cluster health" });
  await expect(health).toBeVisible();
  for (const label of metricLabels) {
    await expectDecimal(health, label);
  }

  await assertWidth(page, "metrics-panel", 1280);
  await assertWidth(page, "metrics-panel", 360);
});

async function expectDecimal(region: Locator, label: string): Promise<void> {
  const term = region.locator("dt", { hasText: new RegExp(`^${label}$`) });
  await expect(term).toBeVisible();
  const value = term.locator("xpath=following-sibling::dd[1]");
  await expect(value).toBeVisible();
  await expect(value, label).toHaveText(/^[0-9]+$/);
}
