import { expect, request, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { administrator } from "./accounts";
import { assertAuthenticated, chooseTheme, openUpload, closeUpload, openNavigation, openAccount, openDisclosure, selectChoice } from "./interactions";

const evidence = process.env.GARAGE_UI_E2E_EVIDENCE_DIR ?? "/tmp/garage-ui-mobile-browser";
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,120,156,99,248,207,192,0,0,3,1,1,0,201,254,146,239,0,0,0,0,73,69,78,68,174,66,96,130]);

for (const [width, theme] of [[360, "Light"], [390, "Dark"]] as const) {
  test(`mobile files remain useful on the first screen ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.getByLabel("Username").fill(administrator.username);
    await page.getByLabel("Password").fill(administrator.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await assertAuthenticated(page);
    await chooseTheme(page, theme);
    const cleanup = await request.newContext({ baseURL: "http://127.0.0.1:3909", storageState: await page.context().storageState(), timeout: 10_000 });
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
    const headers = { "x-csrf-token": csrf };
    const stamp = Date.now().toString(36);
    const longName = `设计草案-${"完整可读文件名".repeat(12)}.txt`;
    const files = [
      { key: "notes.txt", type: "text/plain", body: Buffer.from("Real sample notes for mobile acceptance.") },
      { key: "photo.png", type: "image/png", body: png },
      { key: "reports/weekly.csv", type: "text/csv", body: Buffer.from("week,uploads\n2026-10-12,128\n") },
      { key: "design-assets/palette.txt", type: "text/plain", body: Buffer.from("Ocean blue #2463eb\n") },
      { key: longName, type: "text/plain", body: Buffer.from("A real Unicode object with a full readable key.") },
    ];
    let bucketId = "";
    let keyId = "";
    const uploaded: string[] = [];
    const failures: unknown[] = [];
    mkdirSync(evidence, { recursive: true });
    try {
      const bucket = await page.request.post("/api/buckets", { headers, data: { globalAlias: `sample-assets-${stamp}` } });
      expect(bucket.status()).toBe(200);
      bucketId = (await bucket.json() as { id: string }).id;
      const key = await page.request.post("/api/keys", { headers, data: { name: `sample-mobile-${stamp}` } });
      expect(key.status()).toBe(200);
      const created = await key.json() as { accessKeyId?: string; id?: string };
      keyId = created.accessKeyId ?? created.id ?? "";
      expect(keyId).not.toBe("");
      writeFileSync(`${evidence}/fixture-${width}-${theme.toLowerCase()}.json`, JSON.stringify({ bucketId, keyId, objects: files.map((file) => file.key) }, null, 2));
      expect((await page.request.post(`/api/buckets/${bucketId}/permissions`, { headers, data: { accessKeyId: keyId, permissions: { owner: true, read: true, write: true } } })).status()).toBe(200);
      await page.goto(`/#bucket/${bucketId}/objects`);
      const objects = page.locator('section[aria-label="Objects"]');
      await selectChoice(objects.getByLabel("Bucket key"), keyId);
      await objects.getByRole("button", { name: "Use this key", exact: true }).click();
      await expect(objects.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible();
      for (const file of files) {
        expect((await page.request.put(`/api/buckets/${bucketId}/objects/${file.key.split("/").map(encodeURIComponent).join("/")}`, { headers: { ...headers, "content-type": file.type, "content-length": String(file.body.length) }, data: file.body })).status()).toBe(201);
        uploaded.push(file.key);
      }
      await page.reload();
      await expect(objects.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
      await expect(objects).toHaveAttribute("aria-busy", "false");
      await page.waitForLoadState("networkidle");
      const header = page.getByRole("banner");
      await header.scrollIntoViewIfNeeded();
      await expect.poll(async () => (await header.boundingBox())?.y).toBe(0);
      const metrics = await geometry(page, objects);
      writeFileSync(`${evidence}/geometry-${width}-${theme.toLowerCase()}.json`, JSON.stringify(metrics, null, 2));
      await page.screenshot({ path: `${evidence}/objects-${width}-${theme.toLowerCase()}-viewport.png`, fullPage: false });
      expect(metrics.simpleVisible, "At least three complete simple records must fit in the initial 800px screen").toBeGreaterThanOrEqual(3);
      expect(metrics.firstTop, "The first loaded record must begin by 460px").toBeLessThanOrEqual(460);
      for (const row of metrics.rows) if (!row.long) expect(row.height, `${row.name} record height`).toBeLessThanOrEqual(row.folder ? 80 : 100);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(width);
      await phoneShell(page);
      const uploadButton = objects.getByRole("button", { name: /^Upload(?: · \d+)?$/ });
      await expect(uploadButton).toHaveCount(1);
      await touchTarget(uploadButton, width);
      await expect(objects.getByLabel("Choose files")).not.toBeVisible();
      await expect(objects.locator("summary:visible").filter({ hasText: /^Close upload/ })).toHaveCount(0);
      const notes = objects.locator("tbody tr").filter({ has: page.getByRole("button", { name: "notes.txt", exact: true }) });
      await expect(notes.locator("small:visible")).toContainText(`${files[0].body.length} B`);
      await expect(notes.locator("time:visible")).toHaveAttribute("datetime", /Z$/);
      await touchTarget(notes.getByRole("button", { name: "notes.txt", exact: true }), width);
      await touchTarget(notes.getByRole("button", { name: "Details (notes.txt)", exact: true }), width);
      await touchTarget(notes.locator("label"), width);
      await objects.getByRole("button", { name: "reports/", exact: true }).click();
      await expect(objects.getByRole("button", { name: "reports/weekly.csv", exact: true })).toBeVisible();
      await objects.getByRole("button", { name: `Root (${bucketId})`, exact: true }).click();
      await objects.getByLabel("Search", { exact: true }).fill("notes");
      await objects.getByRole("button", { name: "Search", exact: true }).click();
      await expect(objects.getByRole("button", { name: "photo.png", exact: true })).toHaveCount(0);
      await objects.getByRole("button", { name: "notes.txt", exact: true }).click();
      const preview = objects.getByRole("region", { name: "Object details", exact: true });
      await expect(preview).toBeFocused();
      await expect(preview.locator("pre")).toHaveText(files[0].body.toString());
      await objects.getByLabel("Search", { exact: true }).fill("");
      await objects.getByRole("button", { name: "Search", exact: true }).click();
      await notes.getByRole("button", { name: "Details (notes.txt)", exact: true }).click();
      const inspector = objects.getByRole("region", { name: "Inspect notes.txt", exact: true });
      await expect(inspector).toBeFocused();
      await expect(inspector.getByText(`Size ${files[0].body.length}`, { exact: true })).toBeVisible();
      await openDisclosure(inspector.locator("summary").filter({ hasText: "Exact timestamp" }));
      await expect(inspector.locator("code")).toContainText("Z");
      await objects.getByRole("checkbox", { name: "Select notes.txt", exact: true }).click();
      await objects.getByRole("checkbox", { name: "Select photo.png", exact: true }).click();
      const bulk = objects.locator(".ui-objects-bulk");
      await expect(bulk.getByText("2 objects", { exact: true })).toBeVisible();
      await expect(bulk.getByRole("button", { name: "Download ZIP", exact: true })).toBeEnabled();
      await bulk.getByRole("button", { name: "Clear selection", exact: true }).click();
      await expect(objects.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await objects.getByRole("button", { name: longName, exact: true }).click();
      await expect(preview.locator("pre")).toHaveText(files[4].body.toString());
      await expect(preview.getByRole("heading", { name: longName, exact: true })).toHaveText(longName);
      const writes: string[] = [];
      page.on("request", (sent) => { if (sent.method() === "PUT" && new URL(sent.url()).pathname.endsWith("/objects/notes.txt")) writes.push(sent.url()); });
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Explicitly confirmed mobile overwrite.") });
      const upload = objects.getByRole("region", { name: "Upload", exact: true });
      const queued = upload.getByRole("listitem").filter({ hasText: "notes.txt" });
      await expect(queued.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
      expect(writes).toHaveLength(0);
      const hash = new URL(page.url()).hash;
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("link", { name: "← Buckets", exact: true }).click();
      expect(new URL(page.url()).hash).toBe(hash);
      await expect(queued.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
      await closeUpload(objects);
      await expect(uploadButton, "Closing upload must return keyboard focus to its visible entry").toBeFocused();
      const closedFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent, visible: document.activeElement instanceof HTMLElement && document.activeElement.getBoundingClientRect().height > 0 }));
      writeFileSync(`${evidence}/close-upload-focus-${width}.json`, JSON.stringify(closedFocus, null, 2));
      await openUpload(objects);
      await expect(queued.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
      await queued.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(queued.getByText("Cancelled", { exact: true })).toBeVisible();
      await closeUpload(objects);
      await openUpload(objects);
      await expect(queued.getByText("Cancelled", { exact: true })).toBeVisible();
      await queued.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(queued.getByRole("button", { name: "Overwrite", exact: true })).toBeVisible();
      expect(writes).toHaveLength(0);
      await page.screenshot({ path: `${evidence}/upload-queue-${width}-${theme.toLowerCase()}.png`, fullPage: false });
      await queued.getByRole("button", { name: "Overwrite", exact: true }).click();
      await expect(queued.getByText("Done", { exact: true })).toBeVisible();
      expect(writes).toHaveLength(1);
      await upload.getByRole("button", { name: "Clear finished", exact: true }).click();
      await closeUpload(objects);
      await page.reload();
      await expect(objects.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
      for (const largeWidth of [768, 1280]) {
        await page.setViewportSize({ width: largeWidth, height: 800 });
        await page.getByRole("banner").scrollIntoViewIfNeeded();
        if (largeWidth === 1280) {
          const time = notes.locator(".ui-objects-time");
          await expect(time).toBeVisible();
          expect((await bounds(time)).width, "Readable desktop UTC column").toBeGreaterThanOrEqual(100);
        } else {
          await expect(notes.locator("time:visible")).toHaveAttribute("datetime", /Z$/);
          await expect(notes.locator("small:visible")).toContainText("B");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(largeWidth);
        await page.screenshot({ path: `${evidence}/objects-${largeWidth}-${theme.toLowerCase()}-viewport.png`, fullPage: false });
      }
      await page.setViewportSize({ width, height: 800 });
      await management(page, bucketId, keyId, width, theme);
      if (width === 390) {
        await navigate(page, "Settings");
        await selectChoice(page.getByLabel("Language"), "Chinese");
        await page.goto(`/#bucket/${bucketId}/objects`);
        const chinese = page.locator('section[aria-label="对象"]');
        await expect(chinese.getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();
        await page.getByRole("banner").scrollIntoViewIfNeeded();
        const localized = await geometry(page, chinese);
        expect(localized.simpleVisible).toBeGreaterThanOrEqual(3);
        expect(localized.scrollWidth).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `${evidence}/objects-${width}-dark-zh-viewport.png`, fullPage: false });
        writeFileSync(`${evidence}/geometry-${width}-dark-zh.json`, JSON.stringify(localized, null, 2));
      }
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
            for (const key of uploaded) expect([200, 204, 404]).toContain((await cleanup.delete(`/api/buckets/${bucketId}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, { headers })).status());
          }
          expect((await cleanup.delete(`/api/buckets/${bucketId}`, { headers })).status()).toBe(200);
          console.log(`Mobile fixture bucket cleanup ${bucketId}: 200`);
        }
        if (keyId) {
          expect((await cleanup.delete(`/api/keys/${keyId}`, { headers })).status()).toBe(200);
          console.log(`Mobile fixture key cleanup ${keyId}: 200`);
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      } finally { await cleanup.dispose(); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Mobile workflow and owned fixture cleanup failed");
    if (failures.length === 1) throw failures[0];
  });
}

async function geometry(page: Page, objects: Locator) {
  const rows = await objects.locator("tbody tr").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    const name = node.querySelector("button.ui-object-name")?.textContent ?? "";
    return { name, top: box.top, bottom: box.bottom, height: box.height, folder: name.endsWith("/"), long: name.startsWith("设计草案-") };
  }));
  return { rows, firstTop: rows[0]?.top ?? Infinity, simpleVisible: rows.filter((row) => !row.long && row.top >= 0 && row.bottom <= 800).length, scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth) };
}

async function touchTarget(control: Locator, width: number) {
  const box = await bounds(control);
  expect(box.width).toBeGreaterThanOrEqual(36);
  expect(box.height).toBeGreaterThanOrEqual(36);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

async function phoneShell(page: Page) {
  const header = page.getByRole("banner");
  const menu = header.getByRole("button", { name: "Menu", exact: true });
  const parent = header.getByRole("link", { name: "← Buckets", exact: true });
  const account = header.locator(".console-account-trigger");
  for (const control of [menu, parent, account]) await touchTarget(control, page.viewportSize()?.width ?? 0);
  const boxes = await Promise.all([bounds(menu), bounds(parent), bounds(account)]);
  const centers = boxes.map((box) => box.y + box.height / 2);
  expect(Math.max(...centers) - Math.min(...centers), "Appbar controls must share one row").toBeLessThanOrEqual(8);
  for (let index = 1; index < boxes.length; index++) expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await openAccount(page);
  await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeEnabled();
  await account.click();
}

async function navigate(page: Page, name: string) {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
}

async function management(page: Page, bucketId: string, keyId: string, width: number, theme: string) {
  const rows: Record<string, number> = {};
  await page.getByRole("link", { name: "← Buckets", exact: true }).click();
  await page.getByLabel("Filter buckets").fill(bucketId);
  const bucket = page.locator("tbody tr").filter({ has: page.getByRole("button", { name: `Open objects (${bucketId})`, exact: true }) });
  await expect(bucket).toBeVisible();
  rows.Buckets = (await bounds(bucket)).height;
  expect(rows.Buckets, "A closed simple bucket record must remain compact on phone").toBeLessThanOrEqual(220);
  await openDisclosure(bucket.locator(".ui-identity-details > summary"));
  await expect(bucket.locator(".ui-identity-details > code")).toHaveText(bucketId);
  await touchTarget(bucket.getByRole("button", { name: "Copy ID", exact: true }), width);
  await bucket.locator(".ui-identity-details > summary").click();
  await page.screenshot({ path: `${evidence}/buckets-${width}-${theme.toLowerCase()}.png`, fullPage: false });
  await navigate(page, "Keys");
  await page.getByLabel("Filter keys").fill(keyId);
  const key = page.locator("tbody tr").filter({ has: page.locator(`a[href="#key/${keyId}/overview"]`) });
  await expect(key).toBeVisible();
  rows.Keys = (await bounds(key)).height;
  await key.getByRole("button", { name: `Actions (${keyId})`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Name", exact: true }).getByLabel(`Name for ${keyId}`, { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Name", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(key.getByRole("button", { name: `Delete ${keyId}`, exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/keys-${width}-${theme.toLowerCase()}.png`, fullPage: false });
  await navigate(page, "Users");
  const user = page.locator("tbody tr").first();
  await expect(user).toBeVisible();
  rows.Users = (await bounds(user)).height;
  await user.getByRole("button", { name: /^Actions: / }).click();
  await expect(page.getByRole("dialog").getByRole("combobox")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `${evidence}/users-${width}-${theme.toLowerCase()}.png`, fullPage: false });
  writeFileSync(`${evidence}/management-${width}-${theme.toLowerCase()}.json`, JSON.stringify(rows, null, 2));
}

async function bounds(control: Locator) {
  const box = await control.boundingBox();
  if (box === null) throw new Error(`Visible control has no bounds: ${await control.toString()}`);
  return box;
}
