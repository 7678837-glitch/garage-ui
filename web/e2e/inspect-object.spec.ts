import { assertAuthenticated, bucketIdFromRow, openDisclosure, openNavigation, openRowActions, openUpload } from "./interactions";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const ownedPrefix = "e2e-305-";
const flags = ["encrypted", "uploading", "aborted", "deleteMarker", "inline"] as const;

test("an administrator inspects one uploaded object", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const suffix = Date.now().toString(36);
  const alias = `${ownedPrefix}${suffix}`;
  const keyName = `${ownedPrefix}key-${suffix}`;
  const objectKey = "note.txt";
  const work = mkdtempSync(join(tmpdir(), ownedPrefix));
  writeFileSync(join(work, objectKey), "inspect\n");
  let bucketId = "";

  try {
    await logIn(page);
    const keyId = await createKey(page, keyName);
    await createBucket(page, alias);
    await reloadUntilAlias(page, alias);
    bucketId = await filterGrantAndOpen(page, alias, keyId);
    const objects = page.locator("section[aria-label=\"Objects\"]");
    await bindKey(objects, keyId);
    await objects.locator("summary").filter({ hasText: /^Upload$/ }).click();
    await openUpload(objects);
    await objects.getByLabel("Choose files").setInputFiles(join(work, objectKey));
    const upload = page.getByRole("region", { name: "Upload" });
    await expect(
      upload.getByRole("listitem").filter({ hasText: objectKey }).getByText("Done", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(objects.getByRole("button", { name: objectKey, exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await objects.getByRole("button", { name: `Details (${objectKey})`, exact: true }).click();
    const inspected = objects.getByRole("region", { name: `Inspect ${objectKey}`, exact: true });
    await expect(inspected).toBeVisible();
    await expect(inspected.getByText(/^encrypted (yes|no)$/)).toBeVisible();
    const lines = (await inspected.locator("p").allInnerTexts()).map((line) => line.trim());
    const versions = lines.filter((line) => !flags.some((flag) => line.startsWith(`${flag} `)));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(lines.filter((line) => new RegExp(`^${flag} (yes|no)$`).test(line))).toHaveLength(1);
    }
    await assertWidth(page, "inspect-object", 1280);
    await assertWidth(page, "inspect-object", 360);
  } finally {
    rmSync(work, { recursive: true, force: true });
    await cleanup(page, alias, bucketId, objectKey);
  }
});

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

async function createKey(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Keys", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keys", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Key name").fill(name);
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const heading = page.getByRole("heading", { name: /^Secret for / });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  const keyId = (await heading.innerText()).replace(/^Secret for /, "");
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return keyId;
}

async function createBucket(page: Page, alias: string): Promise<void> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await expect(page.getByText("Bucket created", { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function reloadUntilAlias(page: Page, alias: string): Promise<void> {
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(async () => {
    await page.reload();
    await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
    const hit = buckets.getByText(alias, { exact: true });
    for (let step = 0; step < 30; step += 1) {
      await expect(buckets).not.toHaveAttribute("aria-busy", "true");
      if ((await hit.count()) > 0) {
        return;
      }
      const more = buckets.getByRole("button", { name: "Load more", exact: true });
      if (!(await more.isVisible())) {
        break;
      }
      await more.click();
    }
    await expect(hit).toBeVisible();
  }).toPass({ timeout: 90_000 });
}

async function filterGrantAndOpen(page: Page, alias: string, keyId: string): Promise<string> {
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = buckets.locator("tbody tr").filter({ has: page.getByText(alias, { exact: true }) }).first();
  await expect(row).toBeVisible();
  const bucketId = await bucketIdFromRow(row);
  await openRowActions(row);
  await row.getByRole("button", { name: `Permissions for ${bucketId}`, exact: true }).click();
  await openDisclosure(page.locator("summary", { hasText: "Grant key" }));
  const grant = page.getByRole("form", { name: `Grant permissions on ${bucketId}` });
  await grant.getByLabel("Access key").fill(keyId);
  await grant.getByRole("checkbox", { name: "Read", exact: true }).check();
  await grant.getByRole("checkbox", { name: "Write", exact: true }).check();
  await grant.getByRole("checkbox", { name: "Owner", exact: true }).check();
  await grant.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(page.getByRole("region", { name: `Permissions for ${bucketId}` }).getByText("write yes", { exact: true })).toBeVisible({ timeout: 20_000 });
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  await row.getByRole("button", { name: `Open objects (${bucketId})`, exact: true }).click();
  await expect(page.locator("section[aria-label=\"Objects\"]")).toBeVisible();
  return bucketId;
}

async function bindKey(objects: Locator, keyId: string): Promise<void> {
  const picker = objects.getByLabel("Bucket key");
  const empty = objects.getByText("There are no objects. Upload the first object.", { exact: true });
  await expect(picker.or(empty)).toBeVisible({ timeout: 20_000 });
  if (await picker.isVisible()) {
    await picker.selectOption(keyId);
    await objects.getByRole("button", { name: "Use this key", exact: true }).click();
  }
  await expect(empty).toBeVisible({ timeout: 20_000 });
}

async function cleanup(page: Page, alias: string, bucketId: string, objectKey: string): Promise<void> {
  if (!alias.startsWith(ownedPrefix)) {
    throw new Error("refusing to delete a bucket outside the e2e-305- prefix");
  }
  if (page.isClosed()) {
    return;
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape").catch(() => undefined);
  await deleteUploadedObject(page, objectKey);
  await deleteBucket(page, alias, bucketId);
}

async function deleteUploadedObject(page: Page, objectKey: string): Promise<void> {
  const objects = page.locator("section[aria-label=\"Objects\"]");
  const keyButton = objects.getByRole("button", { name: objectKey, exact: true });
  if ((await keyButton.count()) === 0) {
    return;
  }
  await objects.getByRole("checkbox", { name: `Select ${objectKey}` }).check();
  await objects.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(keyButton).toHaveCount(0, { timeout: 20_000 });
}

async function deleteBucket(page: Page, alias: string, bucketId: string): Promise<void> {
  if (!alias.startsWith(ownedPrefix)) {
    throw new Error("refusing to delete a bucket outside the e2e-305- prefix");
  }
  const bucketsLink = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Buckets", exact: true });
  if ((await bucketsLink.count()) === 0) {
    return;
  }
  const back = page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true });
  if (await back.isVisible().catch(() => false)) {
    await back.click();
  } else {
    await bucketsLink.click();
  }
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = buckets.locator("tbody tr").filter({ has: page.getByText(alias, { exact: true }) });
  for (let step = 0; step < 30 && (await row.count()) === 0; step += 1) {
    await expect(buckets).not.toHaveAttribute("aria-busy", "true");
    const more = buckets.getByRole("button", { name: "Load more", exact: true });
    if (!(await more.isVisible())) {
      return;
    }
    await more.click();
  }
  if ((await row.count()) === 0) {
    return;
  }
  const id =
    bucketId.length > 0
      ? bucketId
      : await bucketIdFromRow(row.first());
  if (id.length === 0) {
    throw new Error("refusing to delete a bucket with an empty id");
  }
  await openRowActions(row.first());
  await row.first().getByRole("button", { name: `Delete ${id}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete bucket", exact: true }).click();
  await expect(page.getByText("Bucket deleted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(buckets.getByText(alias, { exact: true })).toHaveCount(0);
}
