import { expect, type Locator, type Page } from "@playwright/test";

export async function openDisclosure(summary: Locator): Promise<void> {
  await expect(summary).toHaveCount(1);
  const ancestors = summary.locator("xpath=ancestor::details");
  for (let index = 0; index < await ancestors.count(); index += 1) {
    const details = ancestors.nth(index);
    if (!(await details.evaluate((element) => element.hasAttribute("open")))) await details.locator(":scope > summary").click();
  }
}

export async function openRowActions(row: Locator): Promise<void> {
  await openDisclosure(row.locator("details > summary").filter({ hasText: /^Actions$/ }));
}

export async function bucketIdFromRow(row: Locator): Promise<string> {
  const label = await row.getByRole("button", { name: /^Open objects \(/ }).getAttribute("aria-label");
  const match = /^Open objects \(([0-9a-f]{64})\)$/.exec(label ?? "");
  if (!match) throw new Error(`Unexpected bucket action identity: ${label}`);
  return match[1];
}

export async function openNavigation(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: /^(Menu|菜单)$/ });
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
  await scope.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(scope.getByLabel("Choose files")).toBeFocused();
  await expect(scope.locator("details > summary").filter({ hasText: /^Upload/ }).locator("..")).toHaveAttribute("open", "");
}

export async function openAccount(page: Page): Promise<void> {
  const logout = page.getByRole("button", { name: /^(Log out|退出)$/, includeHidden: true });
  const account = page.locator("details").filter({ has: logout });
  await expect(account).toHaveCount(1);
  await openDisclosure(account.locator("summary"));
  await expect(logout).toBeVisible();
}

export async function assertAuthenticated(page: Page): Promise<void> {
  await openAccount(page);
  await expect(page.getByRole("button", { name: /^(Log out|退出)$/ })).toBeEnabled();
  await page.locator("details").filter({ has: page.getByRole("button", { name: /^(Log out|退出)$/, includeHidden: true }) }).locator("summary").click();
}
