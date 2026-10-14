import { expect, type Locator, type Page } from "@playwright/test";

export async function openDisclosure(summary: Locator): Promise<void> {
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveJSProperty("tagName", "SUMMARY");
  const ancestors = summary.locator("xpath=ancestor::details");
  for (let index = 0; index < await ancestors.count(); index += 1) {
    const details = ancestors.nth(index);
    if (!(await details.evaluate((element) => element.hasAttribute("open")))) await details.locator(":scope > summary").click();
  }
}

export async function openRowActions(row: Locator): Promise<void> {
  await row.getByRole("button", { name: /^Actions(?:$|:|\s|\()/ }).click();
}

export async function selectChoice(control: Locator, label: string): Promise<void> {
  await expect(control).toHaveAttribute("role", "combobox", { timeout: 20_000 });
  await control.click();
  const openedPopup = control.page().getByRole("listbox");
  await expect(openedPopup).toHaveCount(1);
  await expect(openedPopup).toBeVisible();
  const popupId = await openedPopup.getAttribute("id");
  expect(popupId).toBeTruthy();
  const popup = control.page().locator(`[role="listbox"][id="${popupId}"]`);
  await expect(popup).toBeVisible();
  await popup.getByRole("option", { name: label, exact: true }).click();
  await expect(popup).toHaveCount(0);
}

export async function bucketIdFromRow(row: Locator): Promise<string> {
  const label = await row.getByRole("button", { name: /^Open objects \(/ }).getAttribute("aria-label");
  const match = /^Open objects \(([0-9a-f]{64})\)$/.exec(label ?? "");
  if (!match) throw new Error(`Unexpected bucket action identity: ${label}`);
  return match[1];
}

export async function openNavigation(page: Page): Promise<void> {
  const menu = page.getByRole("button", { name: /^(Menu|菜单)$/, includeHidden: true });
  if (await menu.isVisible() && await menu.getAttribute("aria-expanded") !== "true") {
    const exposedMenu = page.getByRole("button", { name: /^(Menu|菜单)$/ });
    await expect(exposedMenu).toBeVisible();
    await exposedMenu.click();
  }
  await expect(page.getByRole("navigation", { name: /^(Sections|分区)$/ })).toBeVisible();
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
  await scope.getByRole("button", { name: /^Upload(?: · \d+)?$/ }).click();
  await expect(scope.getByLabel("Choose files")).toBeFocused();
  const controls = await scope.getByRole("button", { name: /^Upload(?: · \d+)?$/ }).getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  await expect(scope.locator(`details[id="${controls}"]`)).toHaveAttribute("open", "");
}

export async function openAccount(page: Page): Promise<void> {
  const account = page.locator(".console-account-trigger");
  await expect(account).toHaveCount(1);
  if (await account.getAttribute("aria-expanded") !== "true") await account.click();
  await expect(page.getByRole("button", { name: /^(Log out|退出)$/ })).toBeVisible();
}

export async function assertAuthenticated(page: Page): Promise<void> {
  await openAccount(page);
  await expect(page.getByRole("button", { name: /^(Log out|退出)$/ })).toBeEnabled();
  await page.locator(".console-account-trigger").click();
  await expect(page.locator(".console-account-trigger")).toHaveAttribute("aria-expanded", "false");
}

export async function closeUpload(scope: Locator): Promise<void> {
  const summary = scope.locator("details > summary").filter({ hasText: /^Close upload/ });
  await summary.click();
  await expect(summary.locator("..")).not.toHaveAttribute("open", "");
  await expect(scope.getByLabel("Choose files")).not.toBeVisible();
}
