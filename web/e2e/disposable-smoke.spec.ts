import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { administrator } from "./accounts";
import { assertAuthenticated, closeUpload, openAccount, openNavigation, openUpload } from "./interactions";
import { submitLogin } from "./login";

for (const width of [360, 1280]) {
  test(`auth, bucket, file transfer, and audit export at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.getByLabel("Username").fill(administrator.username);
    await page.getByLabel("Password").fill(administrator.password);
    expect((await submitLogin(page)).status()).toBe(200);
    await assertAuthenticated(page);

    const alias = `e2e-smoke-${randomUUID()}`;
    const filename = "browser-smoke.txt";
    const contents = `Real Garage browser transfer at ${width}px: ${alias}\n`;
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value;
    if (!csrf) throw new Error("Authenticated browser session is missing the CSRF cookie");
    const headers = { "x-csrf-token": csrf };
    let bucketId = "";
    let keyId = "";
    const failures: unknown[] = [];
    try {
      await openNavigation(page);
      await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByLabel("Global alias", { exact: true }).fill(alias);
      const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/buckets");
      await page.getByRole("button", { name: "Create bucket", exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(200);
      bucketId = (await response.json() as { id: string }).id;
      expect(bucketId).toMatch(/^[0-9a-f]{64}$/);
      await expect(page.getByText("Bucket created", { exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Create bucket", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("region", { name: "Buckets" }).getByText(alias, { exact: true })).toBeVisible();

      // Access grants prepare a real S3 upload without making this smoke depend on the key editor.
      const key = await page.request.post("/api/keys", { headers, data: { name: alias } });
      expect(key.status()).toBe(200);
      keyId = (await key.json() as { accessKeyId: string }).accessKeyId;
      expect(keyId).toBeTruthy();
      expect((await page.request.post(`/api/buckets/${bucketId}/permissions`, {
        headers,
        data: { accessKeyId: keyId, permissions: { read: true, write: true, owner: true } },
      })).status()).toBe(200);
      expect((await page.request.put(`/api/buckets/${bucketId}/credential`, {
        headers, data: { access_key_id: keyId },
      })).status()).toBe(200);

      await page.getByRole("button", { name: `Open objects (${bucketId})`, exact: true }).click();
      const objects = page.getByRole("region", { name: "Objects", exact: true });
      await expect(objects.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible();
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from(contents) });
      await expect(objects.getByRole("region", { name: "Upload", exact: true }).getByRole("listitem").filter({ hasText: filename }).getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
      await closeUpload(objects);
      await objects.getByRole("button", { name: filename, exact: true }).click();
      await expect(objects.getByRole("region", { name: "Object details", exact: true }).locator("pre")).toHaveText(contents);
      await objects.getByRole("checkbox", { name: `Select ${filename}`, exact: true }).click();
      const downloadPromise = page.waitForEvent("download");
      await objects.getByRole("link", { name: "Download", exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(filename);
      const saved = testInfo.outputPath("browser-smoke.txt");
      await download.saveAs(saved);
      expect(await readFile(saved, "utf8")).toBe(contents);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      await openNavigation(page);
      await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Audit", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible();
      const exportPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export audit", exact: true }).click();
      const exported = await exportPromise;
      expect(exported.suggestedFilename()).toBe("audit.csv");
      const csvPath = testInfo.outputPath("audit.csv");
      await exported.saveAs(csvPath);
      const csv = await readFile(csvPath, "utf8");
      expect(csv.split(/\r?\n/)[0]).toContain("username");
      expect(csv).toContain(administrator.username);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (bucketId) {
          if (keyId) {
            const removed = await page.request.delete(`/api/buckets/${bucketId}/objects/${filename}`, { headers });
            expect([200, 204, 404]).toContain(removed.status());
          }
          expect((await page.request.delete(`/api/buckets/${bucketId}`, { headers })).status()).toBe(200);
        }
        if (keyId) expect((await page.request.delete(`/api/keys/${keyId}`, { headers })).status()).toBe(200);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Browser smoke or owned resource cleanup failed");
    await openAccount(page);
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  });
}
