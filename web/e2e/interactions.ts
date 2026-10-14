import { expect, type Locator, type Page } from "@playwright/test";

export async function openDisclosure(summary: Locator): Promise<void> {
  await expect(summary).toHaveCount(1);
  const details = summary.locator("..");
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    await summary.click();
  }
}

export async function openNavigation(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible() && await menu.getAttribute("aria-expanded") !== "true") await menu.click();
}

export async function chooseTheme(page: Page, theme: "Light" | "Dark"): Promise<void> {
  const hash = new URL(page.url()).hash;
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Settings", exact: true }).click();
  const button = page.getByRole("button", { name: theme, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.evaluate((destination) => { location.hash = destination; }, hash);
  await expect.poll(() => new URL(page.url()).hash).toBe(hash);
}

export async function openUpload(scope: Locator): Promise<void> {
  await openDisclosure(scope.locator("details > summary").filter({ hasText: /^Upload/ }));
}

export async function openAccount(page: Page): Promise<void> {
  const logout = page.getByRole("button", { name: "Log out", exact: true, includeHidden: true });
  const account = page.locator("details").filter({ has: logout });
  await expect(account).toHaveCount(1);
  await openDisclosure(account.locator("summary"));
  await expect(logout).toBeVisible();
}

export async function assertAuthenticated(page: Page): Promise<void> {
  await openAccount(page);
  await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeEnabled();
  await page.locator("details").filter({ has: page.getByRole("button", { name: "Log out", exact: true, includeHidden: true }) }).locator("summary").click();
}
