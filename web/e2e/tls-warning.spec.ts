import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const warning = "TLS certificate verification is off.";

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

function tlsAlert(page: Page) {
  return page.getByRole("alert").filter({ hasText: warning });
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

test("shows the TLS warning on overview only", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);

  const alert = tlsAlert(page);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(warning);
  await expect(alert.getByRole("button")).toHaveCount(0);

  await assertWidth(page, "tls-warning-overview", 1280);
  await assertWidth(page, "tls-warning-overview", 360);

  await page.setViewportSize({ width: 1280, height: 800 });
  await sections(page).getByRole("link", { name: "Buckets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buckets" })).toBeVisible();
  await expect(tlsAlert(page)).toHaveCount(0);
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);

  await assertWidth(page, "tls-warning-buckets", 1280);
  await assertWidth(page, "tls-warning-buckets", 360);
});
