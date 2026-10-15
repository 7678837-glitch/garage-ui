import { submitLogin } from "./login";
import { expect, request, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { closeUpload, assertAuthenticated, openUpload, selectChoice } from "./interactions";
import { assertWidth, evidenceDir } from "./layout";

test("confirms a hidden existing destination and refreshes an open preview after overwrite", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
  await assertAuthenticated(page);
  const cleanup = await request.newContext({ baseURL: "http://127.0.0.1:3909", storageState: await page.context().storageState(), timeout: 10_000 });
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  const headers = { "x-csrf-token": csrf };
  const stamp = Date.now().toString(36);
  const fileName = "hidden-existing.txt";
  const prefix = `visible-${stamp}`;
  const objectKey = `${prefix}/${fileName}`;
  const inputDirectory = mkdtempSync(join(tmpdir(), "garage-ui-overwrite-"));
  const folder = join(inputDirectory, prefix);
  mkdirSync(folder);
  writeFileSync(join(folder, "marker.txt"), "A real visible folder marker.");
  let bucketId = "";
  let keyId = "";
  const uploaded: string[] = [];
  const failures: unknown[] = [];
  try {
    const bucket = await page.request.post("/api/buckets", { headers, data: { globalAlias: `e2e-overwrite-${stamp}` } });
    expect(bucket.status()).toBe(200);
    bucketId = (await bucket.json() as { id: string }).id;
    const key = await page.request.post("/api/keys", { headers, data: { name: `e2e-overwrite-key-${stamp}` } });
    expect(key.status()).toBe(200);
    const created = await key.json() as { accessKeyId?: string; id?: string };
    keyId = created.accessKeyId ?? created.id ?? "";
    expect(keyId).not.toBe("");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/overwrite-fixture-${stamp}.json`, JSON.stringify({ bucketId, keyId, objectKeys: [objectKey, `${prefix}/marker.txt`] }, null, 2));
    expect((await page.request.post(`/api/buckets/${bucketId}/permissions`, { headers, data: { accessKeyId: keyId, permissions: { owner: true, read: true, write: true } } })).status()).toBe(200);
    await page.goto(`/#bucket/${bucketId}/objects`);
    const objects = page.locator('section[aria-label="Objects"]');
    await selectChoice(objects.getByLabel("Bucket key"), keyId);
    await objects.getByRole("button", { name: "Use this key", exact: true }).click();
    await expect(objects.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible();
    const upload = objects.getByRole("region", { name: "Upload", exact: true });
    const writes: string[] = [];
    const objectPath = `/api/buckets/${bucketId}/object`;
    const isObject = (raw: string) => { const url = new URL(raw); return url.pathname === objectPath && url.searchParams.get("key") === objectKey; };
    page.on("request", (sent) => { if (sent.method() === "PUT" && isObject(sent.url())) writes.push(objectPath); });
    const original = "Original real object body.";
    const hiddenReplacement = "Confirmed overwrite while the original row is hidden.";
    const previewReplacement = "Confirmed overwrite automatically refreshes this open preview.";
    await openUpload(objects);
    await objects.getByLabel("Choose folder").setInputFiles(folder);
    await expect(upload.getByRole("listitem").filter({ hasText: `${prefix}/marker.txt` }).getByText("Done", { exact: true })).toBeVisible();
    uploaded.push(`${prefix}/marker.txt`);
    await upload.getByRole("button", { name: "Clear finished", exact: true }).click();
    await closeUpload(objects);
    await objects.getByRole("button", { name: `${prefix}/`, exact: true }).click();
    await expect(objects.getByRole("button", { name: `${prefix}/marker.txt`, exact: true })).toBeVisible();
    // Another client writes the destination after the list loaded, so only the existence check can find it.
    const seeded = await cleanup.put(`${objectPath}?key=${encodeURIComponent(objectKey)}`, { headers: { ...headers, "content-type": "text/plain" }, data: Buffer.from(original) });
    uploaded.push(objectKey);
    expect(seeded.status()).toBe(201);
    await expect(objects.getByRole("button", { name: objectKey, exact: true })).toHaveCount(0);
    await openUpload(objects);
    const checked = page.waitForResponse((result) => result.request().method() === "GET" && isObject(result.url()));
    await objects.getByLabel("Choose files").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from(hiddenReplacement) });
    expect((await checked).status()).toBe(200);
    await expect(upload.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await page.screenshot({ path: `${evidenceDir}/overwrite-hidden-destination-1280-viewport.png`, fullPage: false });
    await upload.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect(upload.getByRole("listitem").filter({ hasText: fileName }).getByText("Done", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    await objects.getByRole("button", { name: objectKey, exact: true }).click();
    const preview = objects.getByRole("region", { name: "Object details", exact: true });
    await expect(preview.locator("pre")).toHaveText(hiddenReplacement);
    await upload.getByRole("button", { name: "Clear finished", exact: true }).click();
    await openUpload(objects);
    await objects.getByLabel("Choose files").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from(previewReplacement) });
    await expect(upload.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
    await expect(preview.locator("pre")).toHaveText(hiddenReplacement);
    expect(writes).toHaveLength(1);
    await upload.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect(upload.getByRole("listitem").filter({ hasText: fileName }).getByText("Done", { exact: true })).toBeVisible();
    await expect(preview.locator("pre")).toHaveText(previewReplacement, { timeout: 20_000 });
    expect(writes).toHaveLength(2);
    await closeUpload(objects);
    await objects.getByRole("button", { name: objectKey, exact: true }).click();
    await expect(preview).toBeFocused();
    await expect(preview).toBeInViewport();
    await assertWidth(page, "overwrite-open-preview", 1280);
    writeFileSync(`${evidenceDir}/overwrite-evidence-${stamp}.json`, JSON.stringify({ destinationCheckStatus: 200, writesBeforeConfirmation: [0, 1], totalConfirmedWrites: writes.length, openPreview: await preview.locator("pre").innerText() }, null, 2));
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (bucketId) {
        if (uploaded.length > 0) {
          expect(keyId).not.toBe("");
          const binding = await cleanup.put(`/api/buckets/${bucketId}/credential`, { headers, data: { access_key_id: keyId } });
          expect(binding.status()).toBe(200);
          expect(await binding.json()).toMatchObject({ access_key_id: keyId });
          for (const key of uploaded) expect([200, 204, 404]).toContain((await cleanup.delete(`/api/buckets/${bucketId}/object?key=${encodeURIComponent(key)}`, { headers })).status());
        }
        const removed = await cleanup.delete(`/api/buckets/${bucketId}`, { headers });
        expect(removed.status()).toBe(200);
        console.log(`Overwrite fixture bucket cleanup ${bucketId}: ${removed.status()}`);
      }
      if (keyId) {
        const removed = await cleanup.delete(`/api/keys/${keyId}`, { headers });
        expect(removed.status()).toBe(200);
        console.log(`Overwrite fixture key cleanup ${keyId}: ${removed.status()}`);
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    } finally { await cleanup.dispose(); rmSync(inputDirectory, { recursive: true, force: true }); }
  }
  if (failures.length > 1) throw new AggregateError(failures, "Overwrite workflow and owned fixture cleanup failed");
  if (failures.length === 1) throw failures[0];
});
