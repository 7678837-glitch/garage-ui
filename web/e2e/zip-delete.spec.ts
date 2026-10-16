import { submitLogin } from "./login";
import { assertAuthenticated, bucketIdFromRow, openNavigation, openRowActions, openUpload, selectChoice } from "./interactions";
import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const ownedPrefix = "e2e-312-";
const batchA = "batch-a";
const batchB = "batch-b";
const leafText = "leaf";

test.use({ acceptDownloads: true });

test("deletes a selection, deletes a folder, and downloads a ZIP", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const suffix = Date.now().toString(36);
  const alias = `${ownedPrefix}${suffix}`;
  const keyName = `${ownedPrefix}key-${suffix}`;
  const work = mkdtempSync(join(tmpdir(), ownedPrefix));
  const goneRoot = join(work, "gone");
  mkdirSync(goneRoot);
  writeFileSync(join(work, "batch-a.txt"), batchA);
  writeFileSync(join(work, "batch-b.txt"), batchB);
  writeFileSync(join(goneRoot, "leaf.txt"), leafText);
  let bucketId = "";
  let keyId = "";

  try {
    await logIn(page);
    keyId = await createKey(page, keyName);
    await createBucket(page, alias);
    await reloadUntilAlias(page, alias);
    bucketId = await filterGrantAndOpen(page, alias, keyId);
    const objects = page.locator("section[aria-label=\"Objects\"]");
    const upload = page.getByRole("region", { name: "Upload" });
    await bindKey(objects, keyId);
    await openUpload(objects);
    await objects.getByLabel("Choose files").setInputFiles([
      join(work, "batch-a.txt"),
      join(work, "batch-b.txt"),
    ]);
    await expect(uploadRow(upload, "batch-a.txt").getByText("Done", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(uploadRow(upload, "batch-b.txt").getByText("Done", { exact: true })).toBeVisible();
    await openUpload(objects);
    await objects.getByLabel("Choose folder").setInputFiles(goneRoot);
    await expect(uploadRow(upload, "gone/leaf.txt").getByText("Done", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(objects.getByRole("button", { name: "batch-a.txt", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(objects.getByRole("button", { name: "batch-b.txt", exact: true })).toBeVisible();
    await expect(objects.getByRole("button", { name: "gone/", exact: true })).toBeVisible();

    await objects.getByRole("checkbox", { name: "Select batch-a.txt" }).click();
    await objects.getByRole("checkbox", { name: "Select batch-b.txt" }).click();
    await expect(objects.getByRole("button", { name: "Download ZIP", exact: true })).toBeVisible();
    await expect(objects.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    await assertWidth(page, "zip-delete-selection", 1280);
    await assertWidth(page, "zip-delete-selection", 360);
    await page.setViewportSize({ width: 1280, height: 800 });

    const zipPath = await readZip(page, objects);
    const entries = zipEntries(zipPath);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["batch-a.txt", "batch-b.txt"]);
    expect(entries.find((entry) => entry.name === "batch-a.txt")?.text).toBe(batchA);
    expect(entries.find((entry) => entry.name === "batch-b.txt")?.text).toBe(batchB);

    await objects.getByRole("button", { name: "Delete", exact: true }).click();
    const batchDialog = page.getByRole("dialog");
    await expect(batchDialog.getByRole("heading", { name: "Confirm 2" })).toBeVisible();
    await expect(batchDialog).toContainText("Deletes 2 objects");
    const batchConfirm = batchDialog.getByRole("button", { name: "Confirm", exact: true });
    await expect(batchConfirm).toBeDisabled();
    await batchDialog.getByLabel("Type 2 to confirm").fill("1");
    await expect(batchConfirm).toBeDisabled();
    await assertWidth(page, "zip-delete-batch", 1280);
    await assertWidth(page, "zip-delete-batch", 360);
    await page.setViewportSize({ width: 1280, height: 800 });
    await batchDialog.getByLabel("Type 2 to confirm").fill("2");
    await expect(batchConfirm).toBeEnabled();
    await batchConfirm.click();
    await expect(batchDialog).toHaveCount(0);
    await expect(objects.getByRole("button", { name: "batch-a.txt", exact: true })).toHaveCount(0);
    await expect(objects.getByRole("button", { name: "batch-b.txt", exact: true })).toHaveCount(0);

    await expect(objects.getByRole("button", { name: "gone/", exact: true })).toBeVisible();
    await assertWidth(page, "zip-delete-folder", 1280);
    await assertWidth(page, "zip-delete-folder", 360);
    await page.setViewportSize({ width: 1280, height: 800 });
    const folderRow = objects.locator("tbody tr").filter({ has: page.getByRole("button", { name: "gone/", exact: true }) });
    await openRowActions(folderRow);
    await page.getByRole("menuitem", { name: "Delete folder (gone/)", exact: true }).click();
    const folderDialog = page.getByRole("dialog");
    await expect(folderDialog.getByRole("heading", { name: "Confirm gone/" })).toBeVisible();
    await expect(folderDialog).toContainText("This deletes every object under this prefix.");
    const folderConfirm = folderDialog.getByRole("button", { name: "Confirm", exact: true });
    await expect(folderConfirm).toBeDisabled();
    await folderDialog.getByLabel("Type gone/ to confirm").fill("gone");
    await expect(folderConfirm).toBeDisabled();
    await folderDialog.getByLabel("Type gone/ to confirm").fill("gone/");
    await expect(folderConfirm).toBeEnabled();
    await folderConfirm.click();
    await expect(folderDialog).toHaveCount(0);
    await expect(objects.getByRole("button", { name: "gone/", exact: true })).toHaveCount(0);
    const leaf = await page.request.get(objectUrl(bucketId, "gone/leaf.txt"));
    expect(leaf.status()).toBe(404);
  } finally {
    rmSync(work, { recursive: true, force: true });
    await cleanup(page, alias, bucketId, keyId);
  }
});

function zipEntries(file: string): { name: string; text: string }[] {
  const script = [
    "import json, sys, zipfile",
    "archive = zipfile.ZipFile(sys.argv[1])",
    "rows = [{'name': info.filename, 'text': archive.read(info).decode()} for info in archive.infolist()]",
    "print(json.dumps(rows))",
  ].join("\n");
  const raw = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
  return JSON.parse(raw) as { name: string; text: string }[];
}

async function readZip(page: Page, objects: Locator): Promise<string> {
  const downloadTask = page.waitForEvent("download", { timeout: 30_000 });
  const popupTask = page.context().waitForEvent("page", { timeout: 30_000 }).then(async (popup) => {
    const download = await popup.waitForEvent("download", { timeout: 30_000 });
    return download;
  });
  // WebKit can open a popup but deliver its attachment download on the opener.
  const downloaded = Promise.any([downloadTask, popupTask]);
  await objects.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const path = await (await downloaded).path();
  if (!path) throw new Error("ZIP download has no file");
  return path;
}

function uploadRow(upload: Locator, name: string): Locator {
  return upload.getByRole("listitem").filter({ hasText: name });
}

function objectUrl(bucketId: string, key: string): string {
  return `/api/buckets/${encodeURIComponent(bucketId)}/object?key=${encodeURIComponent(key)}`;
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
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
  await page.getByRole("dialog", { name: "Create bucket", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
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
  await page.getByRole("menuitem", { name: `Permissions for ${bucketId}`, exact: true }).click();
  await page.getByRole("button", { name: "Grant key", exact: true }).click();
  const grant = page.getByRole("form", { name: `Grant permissions on ${bucketId}` });
  await grant.getByLabel("Access key").fill(keyId);
  await grant.getByRole("checkbox", { name: "Read", exact: true }).click();
  await grant.getByRole("checkbox", { name: "Write", exact: true }).click();
  await grant.getByRole("checkbox", { name: "Owner", exact: true }).click();
  await grant.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Grant key", exact: true }).getByText("Permissions granted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("dialog", { name: "Grant key", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
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
    await selectChoice(picker, keyId);
    await objects.getByRole("button", { name: "Use this key", exact: true }).click();
  }
  await expect(empty).toBeVisible({ timeout: 20_000 });
}

async function cleanup(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  if (!alias.startsWith(ownedPrefix) || page.isClosed()) {
    return;
  }
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  const headers = await csrfHeader(page);
  if (bucketId.length > 0) {
    await page.request
      .delete(`${objectUrl(bucketId, "gone/")}&recursive=true`, { headers })
      .catch(() => undefined);
    for (const name of ["batch-a.txt", "batch-b.txt"]) {
      await page.request.delete(objectUrl(bucketId, name), { headers }).catch(() => undefined);
    }
    await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}`, { headers }).catch(() => undefined);
  }
  if (keyId.length > 0) {
    await page.request.delete(`/api/keys/${encodeURIComponent(keyId)}`, { headers }).catch(() => undefined);
  }
}

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies("http://127.0.0.1:3909");
  const value = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  return { "x-csrf-token": value };
}
