import { assertAuthenticated, openAccount } from "./interactions";
import { expect, test } from "@playwright/test";
import { administrator } from "./accounts";

test("creates the first administrator from the setup wizard", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create administrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);

  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Create administrator" }).click();

  await assertAuthenticated(page);
  await openAccount(page);
  await expect(page.getByText(`${administrator.username} · admin`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create administrator" })).toHaveCount(0);
});
