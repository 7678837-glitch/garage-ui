import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const pages = [
  ["Workers", "ops-workers"],
  ["Block errors", "ops-blocks"],
  ["Audit", "ops-audit"],
  ["Admin tokens", "ops-tokens"],
] as const;

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

test("opens ops lists at desktop and phone widths", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

  for (const [name, shot] of pages) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await sections(page).getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await assertWidth(page, shot, 1280);
    await assertWidth(page, shot, 360);
  }
});
