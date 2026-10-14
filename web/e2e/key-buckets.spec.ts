import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

function bucketsFor(page: Page, keyId: string) {
  const name = `Buckets for ${keyId}`;
  const quoted = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return page
    .getByRole("region", { name, exact: true })
    .or(page.getByRole("group", { name, exact: true }))
    .or(page.locator(`[aria-label="${quoted}"]`));
}

test("opens the Buckets tab of one live key", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Keys", exact: true })
    .click();

  const keys = page.getByRole("region", { name: "Keys" });
  await expect(keys.getByRole("heading", { name: "Keys", exact: true })).toBeVisible();
  const firstCell = keys.locator("tbody tr").first().locator("td").first();
  const noKeys = keys.getByText(/There are no keys/);
  await expect(firstCell.or(noKeys)).toBeVisible({ timeout: 20_000 });
  if ((await firstCell.count()) === 0) {
    throw new Error("The key list is empty");
  }
  const keyId = ((await firstCell.getByRole("link").getAttribute("aria-label")) ?? "").trim();
  if (keyId.length === 0) {
    throw new Error("The first key id is empty");
  }

  await page.goto(`/#key/${encodeURIComponent(keyId)}/buckets`);
  await expect(page.getByRole("tab", { name: "Buckets", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const buckets = bucketsFor(page, keyId);
  const empty = buckets.getByText("This key cannot access any buckets.", { exact: true });
  const grant = buckets
    .getByRole("row")
    .filter({ hasText: /owner (yes|no)/ })
    .filter({ hasText: /read (yes|no)/ })
    .filter({ hasText: /write (yes|no)/ });
  await expect(empty.or(grant.first())).toBeVisible({ timeout: 20_000 });
  if (await empty.isVisible()) {
    console.log("key-buckets: empty");
  } else {
    await expect(grant.first()).toBeVisible();
    console.log("key-buckets: grants");
  }

  await assertWidth(page, "key-buckets", 1280);
  await assertWidth(page, "key-buckets", 360);
});
