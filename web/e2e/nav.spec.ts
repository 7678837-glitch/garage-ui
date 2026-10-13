import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth, recordLayout } from "./layout";

const deliveredSections = [
  "Overview",
  "Buckets",
  "Keys",
  "Nodes and layout",
  "Workers",
  "Block errors",
  "Audit",
  "Admin tokens",
  "Users",
  "Settings",
] as const;

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

async function logIn(page: Page): Promise<void> {
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

async function expectSections(page: Page, visible: boolean): Promise<void> {
  const nav = sections(page);
  for (const name of deliveredSections) {
    const link = nav.getByRole("link", { name, exact: true });
    if (visible) {
      await expect(link).toBeVisible();
    } else {
      await expect(link).toHaveCount(0);
    }
  }
}

test("logs in, collapses the narrow menu, and opens objects", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await recordLayout(page, "login");

  await logIn(page);
  await expectSections(page, true);
  await recordLayout(page, "overview");

  await sections(page).getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await recordLayout(page, "about");

  await sections(page).getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await recordLayout(page, "logged-out");

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await logIn(page);
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  await expectSections(page, false);
  await assertWidth(page, "menu-collapsed", 360);

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "true");
  await expectSections(page, true);
  await assertWidth(page, "menu-expanded", 360);

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  await expectSections(page, false);

  await page.getByRole("button", { name: "Menu" }).click();
  await sections(page).getByRole("link", { name: "Buckets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buckets" })).toBeVisible();
  const alias = `e2e-252-${Date.now().toString(36)}`;
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await expect(page.getByText("Bucket created")).toBeVisible();
  await expect(page.getByText(alias, { exact: true })).toBeVisible();
  await recordLayout(page, "buckets");

  await page
    .locator("tr", { hasText: alias })
    .getByRole("button", { name: /^Objects for / })
    .click();
  await expect(page.getByRole("button", { name: "Back to buckets" })).toBeVisible();
  await expect.soft(page.getByText("Global alias")).toHaveCount(0);
  await expect.soft(page.getByText("Create bucket")).toHaveCount(0);
  await recordLayout(page, "objects");
});
