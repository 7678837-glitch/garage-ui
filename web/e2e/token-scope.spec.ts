import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const fullAdminWarning = "This scope is equivalent to full admin access.";

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

test("shows the full-admin warning for CreateAdminToken and stays within the viewport", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Admin tokens", exact: true })
    .click();
  const tokens = page.getByRole("region", { name: "Admin tokens" });
  await expect(tokens.getByRole("heading", { name: "Admin tokens" })).toBeVisible();

  const createAdmin = tokens.getByRole("checkbox", { name: "CreateAdminToken", exact: true });
  await expect(createAdmin).toBeVisible();
  await expect(tokens.getByText(fullAdminWarning, { exact: true })).toHaveCount(0);

  await createAdmin.check();
  await expect(createAdmin).toBeChecked();
  await expect(tokens.getByText(fullAdminWarning, { exact: true })).toBeVisible();

  await createAdmin.uncheck();
  await expect(createAdmin).not.toBeChecked();
  await expect(tokens.getByText(fullAdminWarning, { exact: true })).toHaveCount(0);

  await assertWidth(page, "token-scope", 1280);
  await assertWidth(page, "token-scope", 360);
});
