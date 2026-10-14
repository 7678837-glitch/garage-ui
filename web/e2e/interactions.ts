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
