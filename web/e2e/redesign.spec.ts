import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { evidenceDir, assertWidth } from "./layout";
import { closeUpload, assertAuthenticated, chooseTheme, openDisclosure, openNavigation, openUpload } from "./interactions";

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const sections = ["Overview", "Buckets", "Keys", "Nodes and layout", "Workers", "Block errors", "Audit", "Admin tokens", "Users", "Settings"] as const;

async function navigate(page: Page, name: string): Promise<void> {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible();
  await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
  await expect(page.locator('main [aria-label^="Loading"]')).toHaveCount(0);
}

async function accessibility(page: Page, name: string): Promise<void> {
  await page.evaluate(readFileSync(axePath, "utf8"));
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe;
    const result = await axe.run();
    return result.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical");
  });
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/${name}-axe.json`, JSON.stringify(violations, null, 2));
  expect.soft(violations, `${name}: serious/critical accessibility violations`).toEqual([]);
}

for (const width of [1280, 360]) {
  for (const theme of ["Light", "Dark"] as const) {
    test(`redesign delivered pages ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByLabel("Username").fill(administrator.username);
      await page.getByLabel("Password").fill(administrator.password);
      await page.getByRole("button", { name: "Log in" }).click();
      await assertAuthenticated(page);
      await chooseTheme(page, theme);
      mkdirSync(evidenceDir, { recursive: true });
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
      const headers = { "x-csrf-token": csrf };
      const stamp = Date.now().toString(36);
      const bucketResponse = await page.request.post("/api/buckets", { headers, data: { globalAlias: `e2e-redesign-${stamp}` } });
      expect(bucketResponse.ok()).toBe(true);
      const bucket = await bucketResponse.json() as { id: string };
      const keyResponse = await page.request.post("/api/keys", { headers, data: { name: `e2e-redesign-key-${stamp}` } });
      expect(keyResponse.ok()).toBe(true);
      const key = await keyResponse.json() as { id?: string; accessKeyId?: string };
      const keyId = key.accessKeyId ?? key.id ?? "";
      writeFileSync(`${evidenceDir}/fixture-${stamp}.json`, JSON.stringify({ bucketId: bucket.id, keyId, alias: `e2e-redesign-${stamp}`, keyName: `e2e-redesign-key-${stamp}` }, null, 2));
      expect(keyId.length).toBeGreaterThan(0);
      const grant = await page.request.post(`/api/buckets/${bucket.id}/permissions`, { headers, data: { accessKeyId: keyId, permissions: { owner: true, read: true, write: true } } });
      expect(grant.ok()).toBe(true);
      let previewUploaded = false;
      const extraKeys: string[] = [];
      try {
      for (const name of sections) {
        await navigate(page, name);
        const shot = `redesign-${name.toLowerCase().replaceAll(" ", "-")}-${theme.toLowerCase()}`;
        await assertWidth(page, shot, width);
        await accessibility(page, shot);
        if (width === 360 && theme === "Light") {
          for (const extraWidth of [768, 1440]) await assertWidth(page, `${shot}-intermediate`, extraWidth);
          await page.setViewportSize({ width, height: 800 });
        }
        if (width === 360 && ["Buckets", "Nodes and layout", "Users", "Settings"].includes(name)) {
          const stableHash = new URL(page.url()).hash;
          for (const switchedWidth of [768, 1280, 1440, 360]) {
            await page.setViewportSize({ width: switchedWidth, height: 800 });
            await expect.poll(() => new URL(page.url()).hash).toBe(stableHash);
            await expect(page.getByRole("main")).toBeVisible();
            await assertWidth(page, `${shot}-responsive`, switchedWidth);
          }
        }
        if (name === "Buckets" || name === "Keys") {
          // Closed creation must obey native hidden semantics in the integrated CSS.
          await expect(page.getByRole("button", { name: name === "Buckets" ? "Create bucket" : "Create key", exact: true })).not.toBeVisible();
        }
        if (name === "Buckets") {
          const row = page.getByRole("region", { name: "Bucket", exact: true }).locator("tbody tr").filter({ has: page.getByRole("link", { name: `e2e-redesign-${stamp} (${bucket.id})`, exact: true }) });
          await expect(row).toBeVisible();
          console.log(`Bucket row height ${width} ${theme}`, await row.evaluate((element) => element.getBoundingClientRect().height));
          await expect(row.getByRole("button", { name: `Open objects (${bucket.id})`, exact: true })).toBeVisible();
        }
        if (name === "Nodes and layout") {
          const nodes = page.getByRole("region", { name: "Node list", exact: true });
          const identity = nodes.locator("tbody details").filter({ has: page.locator("code") }).first();
          const identifier = identity.locator("summary");
          await expect(identifier).toBeVisible();
          await expect(identity).not.toHaveAttribute("open", "");
          const metrics = await identifier.evaluate((element) => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), text: element.textContent }));
          expect(metrics.height, "compact node identity must fit within two readable text lines").toBeLessThanOrEqual(metrics.lineHeight * 2);
          expect(metrics.text).toContain("…");
          await openDisclosure(identifier);
          await expect(identity.locator("code")).toBeVisible();
          await identifier.click();
          const href = await nodes.locator('a[href^="#node/"]').first().getAttribute("href");
          expect(href).toBeTruthy();
          for (const tab of ["information", "maintenance"]) {
            await page.evaluate((hash) => { location.hash = hash; }, (href ?? "").replace(/information$/, tab));
            await expect(page.getByRole("tab", { name: new RegExp(`^${tab}$`, "i") })).toHaveAttribute("aria-selected", "true");
            await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
            await expect(page.locator('main [aria-label^="Loading"]')).toHaveCount(0);
            await assertWidth(page, `redesign-node-${tab}-${theme.toLowerCase()}`, width);
            await accessibility(page, `node-${tab}`);
          }
        }
        if (name === "Users") {
          const rows = page.getByRole("region", { name: "User list" }).locator("tbody tr");
          expect(await rows.count()).toBeGreaterThan(0);
          console.log(`Users row height ${width} ${theme}`, await rows.first().evaluate((row) => row.getBoundingClientRect().height));
          await openDisclosure(rows.filter({ hasText: "bea" }).locator("summary", { hasText: "Edit" }));
          await expect(page.getByRole("checkbox", { name: "Download for bea", exact: true })).toBeVisible();
        }
        if (name === "Audit") {
          const auditResponse = await page.request.get("/api/audit?offset=0&limit=100");
          expect(auditResponse.ok()).toBe(true);
          const auditPage = await auditResponse.json() as { items: unknown[]; hasMore: boolean };
          const added = auditPage.hasMore ? 0 : 101 - auditPage.items.length;
          for (let index = 0; index < added; index += 1) {
            const changed = await page.request.put(`/api/buckets/${bucket.id}/quotas`, { headers, data: { maxObjects: 1000 + index, maxSize: null } });
            expect(changed.ok(), `audit fixture quota update failed (${changed.status()})`).toBe(true);
          }
          console.log("real audit fixture operations added", added);
          if (added > 0) { await navigate(page, "Overview"); await navigate(page, "Audit"); }
          const rows = page.getByRole("region", { name: "Audit events", exact: true }).locator("tbody tr");
          const next = page.getByRole("button", { name: "Next page", exact: true });
          await expect(next).toBeEnabled();
          const firstPage = await rows.allTextContents();
          const nextResponse = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === "GET" && url.pathname === "/api/audit" && url.searchParams.get("offset") === "100" && url.searchParams.get("limit") === "100";
          });
          await next.click();
          expect((await nextResponse).ok()).toBe(true);
          await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
          await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
          expect(await rows.allTextContents()).not.toEqual(firstPage);
          await page.getByRole("button", { name: "Previous page", exact: true }).click();
          await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
          await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
          expect(await rows.allTextContents()).toEqual(firstPage);
          await next.click();
          await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
          const filteredResponse = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === "GET" && url.pathname === "/api/audit" && url.searchParams.get("offset") === "0" && url.searchParams.get("user") === administrator.username;
          });
          await page.getByLabel("User", { exact: true }).fill(administrator.username);
          expect((await filteredResponse).ok()).toBe(true);
          await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
          await page.getByLabel("User", { exact: true }).fill("");
          await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
          await assertWidth(page, `${shot}-pagination`, width);
        }
        if (name === "Workers" || name === "Block errors") {
          const picker = page.getByRole("region", { name: "Select node", exact: true });
          await expect(picker).toBeVisible();
          const node = picker.getByRole("link").filter({ hasNotText: "All nodes" }).first();
          await expect(node).toBeVisible();
          await node.click();
          await expect(picker).toHaveCount(0);
          await expect(page.locator('main [aria-label^="Loading"]')).toHaveCount(0);
          await expect(page.getByRole("main")).toBeVisible();
          await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
          if (name === "Workers") {
            await expect(page.getByRole("region", { name: "Worker list", exact: true }).locator("tbody tr").first()).toBeVisible();
          } else {
            const errors = page.getByRole("region", { name: "Block errors", exact: true });
            await expect(errors.getByText("There are no block errors.", { exact: true }).or(errors.locator("tbody tr").first())).toBeVisible();
          }
          await assertWidth(page, `${shot}-selected`, width);
          await accessibility(page, `${shot}-selected`);
        }
      }
      for (const [resource, id, tabs] of [["bucket", bucket.id, ["overview", "settings", "permissions"]], ["key", keyId, ["overview", "settings", "buckets"]]] as const) {
        for (const tab of tabs) {
          await page.evaluate((hash) => { location.hash = hash; }, `#${resource}/${id}/${tab}`);
          await expect(page.getByRole("tab", { name: new RegExp(`^${tab}$`, "i") })).toHaveAttribute("aria-selected", "true");
          await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
          await expect(page.locator('main [aria-label^="Loading"]')).toHaveCount(0);
          await assertWidth(page, `redesign-${resource}-${tab}-${theme.toLowerCase()}`, width);
          await accessibility(page, `${resource}-${tab}`);
        }
      }
      await page.evaluate((id) => { location.hash = `#buckets/${id}`; }, bucket.id);
      const objects = page.locator('section[aria-label="Objects"]');
      await expect(objects).toBeVisible();
      const picker = objects.getByLabel("Bucket key");
      await expect(picker.locator("option", { hasText: keyId })).toHaveCount(1, { timeout: 20_000 });
      await picker.selectOption(keyId);
      await objects.getByRole("button", { name: "Use this key", exact: true }).click();
      await expect(objects.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible({ timeout: 20_000 });
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles({ name: "preview.txt", mimeType: "text/plain", buffer: Buffer.from("Readable preview below the object list.") });
      await expect(objects.getByRole("button", { name: "preview.txt", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Upload", exact: true }).getByText("Done", { exact: true })).toBeVisible();
      previewUploaded = true;
      await closeUpload(objects);
      await objects.getByRole("button", { name: "preview.txt", exact: true }).click();
      const preview = objects.getByRole("region", { name: "Object details", exact: true });
      await expect(preview).toContainText("Content type text/plain");
      await expect(preview, "filename click must give metadata feedback in the viewport").toBeInViewport();
      await expect(preview).toBeFocused();
      await objects.getByRole("button", { name: "preview.txt", exact: true }).click();
      await expect(preview).toBeInViewport();
      await objects.getByRole("checkbox", { name: "Select preview.txt", exact: true }).check();
      await expect(objects.getByRole("checkbox", { name: "Select preview.txt", exact: true })).toBeFocused();
      await expect(preview.locator("pre")).toHaveText("Readable preview below the object list.");
      await expect(objects.getByRole("checkbox", { name: "Select preview.txt", exact: true })).toBeChecked();
      console.log("single-selection preview viewport", await preview.evaluate((element) => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, height: innerHeight })));
      await assertWidth(page, `redesign-object-preview-${theme.toLowerCase()}`, width);
      await accessibility(page, "object-preview");
      if (width === 360 && theme === "Light") {
        await openUpload(objects);
        const files = Array.from({ length: 24 }, (_, index) => ({ name: `row-${String(index).padStart(2, "0")}.txt`, mimeType: "text/plain", buffer: Buffer.from("List row") }));
        extraKeys.push(...files.map((file) => file.name));
        await objects.getByLabel("Choose files").setInputFiles(files);
        await expect(page.getByRole("region", { name: "Upload", exact: true }).getByRole("listitem").filter({ hasText: "row-23.txt" }).getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(objects.locator("tbody tr")).toHaveCount(25);
        await closeUpload(objects);
        await objects.getByRole("checkbox", { name: "Select preview.txt", exact: true }).uncheck();
        await objects.getByRole("button", { name: "preview.txt", exact: true }).click();
        await expect(preview).toContainText("Content type text/plain");
        await expect(preview, "long-list filename click must give visible metadata feedback").toBeInViewport();
        await expect(preview).toBeFocused();
        await objects.getByRole("button", { name: "Details (preview.txt)", exact: true }).click();
        const inspection = objects.getByRole("region", { name: "Inspect preview.txt", exact: true });
        await expect(inspection).toBeInViewport();
        await expect(inspection).toBeFocused();
        await expect(inspection).toContainText("preview.txt");
        await expect(inspection.getByText(/^encrypted (yes|no)$/)).toBeVisible();
        await expect(inspection.getByText(`Size ${Buffer.byteLength("Readable preview below the object list.")}`, { exact: true })).toBeVisible();
        await openDisclosure(inspection.locator("summary").filter({ hasText: "Exact timestamp" }));
        await expect(inspection.locator("code")).toContainText("Z");
        await accessibility(page, "long-list-inspection");
        await assertWidth(page, "redesign-long-list-inspection", width);
        await objects.getByRole("checkbox", { name: "Select preview.txt", exact: true }).check();
        await expect(preview.locator("pre")).toHaveText("Readable preview below the object list.");
        console.log("long-list preview viewport", await preview.evaluate((element) => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, height: innerHeight })));
        await assertWidth(page, "redesign-long-list-preview", width);
        await expect(objects.getByRole("checkbox", { name: "Select preview.txt", exact: true })).toBeChecked();
      }
      const longPrefix = `long-prefix-${stamp}-${"p".repeat(96)}`;
      const longName = `long readable object name ${"with spaces ".repeat(8)}${stamp}.txt`;
      const longKey = `${longPrefix}/${longName}`;
      const longBody = "Real long-path preview for browser acceptance.";
      const inputDirectory = mkdtempSync(join(tmpdir(), "garage-ui-ux-files-"));
      const folderDirectory = join(inputDirectory, longPrefix);
      mkdirSync(folderDirectory);
      writeFileSync(join(folderDirectory, longName), longBody);
      extraKeys.push(longKey);
      try {
        await openUpload(objects);
        await expect(objects.getByRole("button", { name: "Overwrite", exact: true })).toHaveCount(0);
        await objects.getByLabel("Choose folder").setInputFiles(folderDirectory);
        await expect(page.getByRole("region", { name: "Upload", exact: true }).getByRole("listitem").filter({ hasText: longKey }).getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
        await closeUpload(objects);
        await objects.getByRole("button", { name: `${longPrefix}/`, exact: true }).click();
        const row = objects.locator("tbody tr").filter({ has: page.getByRole("button", { name: longKey, exact: true }) });
        await expect(row).toBeVisible();
        const nameControl = row.getByRole("button", { name: longKey, exact: true });
        const detailsControl = row.getByRole("button", { name: `Details (${longKey})`, exact: true });
        const sizeCell = width === 1280 ? row.locator(".ui-objects-size") : row.locator("small:visible");
        const timeCell = width === 1280 ? row.locator(".ui-objects-time") : row.locator(".ui-objects-summary");
        await expect(timeCell.locator("time")).toHaveAttribute("datetime", /Z$/);
        if (width === 1280) await expect(timeCell).toContainText("UTC");
        const metrics = {
          name: await nameControl.boundingBox(), size: await sizeCell.boundingBox(), time: await timeCell.boundingBox(),
          details: await detailsControl.boundingBox(), checkboxHitArea: await row.getByRole("checkbox").locator("..").boundingBox(),
          horizontalScroll: await row.evaluate((element) => ({ scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
        };
        writeFileSync(`${evidenceDir}/storage-long-record-${theme.toLowerCase()}-${width}.json`, JSON.stringify(metrics, null, 2));
        expect(metrics.horizontalScroll.scrollLeft).toBe(0);
        if (!metrics.size || !metrics.time || !metrics.details || !metrics.checkboxHitArea) throw new Error("Loaded object record has missing control or value bounds");
        await assertWidth(page, `storage-long-record-${theme.toLowerCase()}`, width);
        if (width === 1280) {
          expect(metrics.size.width, "size must remain readable beside a long object name").toBeGreaterThanOrEqual(48);
          expect(metrics.time.width, "UTC time must remain readable beside a long object name").toBeGreaterThanOrEqual(100);
        } else {
          expect(metrics.details.height).toBeGreaterThanOrEqual(44);
          expect(metrics.checkboxHitArea.width).toBeGreaterThanOrEqual(44);
          expect(metrics.checkboxHitArea.height).toBeGreaterThanOrEqual(44);
        }
        for (const control of [nameControl, detailsControl, row.getByRole("checkbox")]) {
          const box = await control.boundingBox();
          if (!box) throw new Error("Object row action has no bounding box");
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await assertWidth(page, `storage-long-record-${theme.toLowerCase()}`, width);
        await nameControl.click();
        await expect(preview).toBeFocused();
        await expect(preview).toBeInViewport();
        await expect(preview.locator("pre")).toHaveText(longBody);
        await detailsControl.click();
        const inspection = objects.getByRole("region", { name: `Inspect ${longKey}`, exact: true });
        await expect(inspection).toBeFocused();
        await expect(inspection).toBeInViewport();
        await expect(inspection.getByText(/^encrypted (yes|no)$/)).toBeVisible();
        await objects.getByLabel("Search", { exact: true }).fill("readable");
        const searched = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === `/api/buckets/${bucket.id}/search` && url.searchParams.get("q") === "readable";
        });
        await objects.getByRole("button", { name: "Search", exact: true }).click();
        expect((await searched).ok()).toBe(true);
        await expect(nameControl).toBeVisible();
        await expect(objects.locator('thead th').getByText("Time (UTC)", { exact: true })).toBeVisible();
        await objects.getByLabel("Search", { exact: true }).fill("");
        await objects.getByRole("button", { name: "Search", exact: true }).click();
        await expect(nameControl).toBeVisible();
        await assertWidth(page, `storage-long-inspection-${theme.toLowerCase()}`, width);
        await accessibility(page, `storage-long-${theme.toLowerCase()}-${width}`);
        if ((width === 360 && theme === "Light") || (width === 1280 && theme === "Dark")) {
          const objectUrl = page.url();
          await openNavigation(page);
          await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Settings", exact: true }).click();
          await page.getByLabel("Language").selectOption("zh-CN");
          await page.goto(objectUrl);
          await expect(page.getByRole("button", { name: longKey, exact: true })).toBeVisible();
          await assertWidth(page, `storage-long-zh-${theme.toLowerCase()}`, width);
          await accessibility(page, `storage-long-zh-${theme.toLowerCase()}-${width}`);
          await openNavigation(page);
          await page.getByRole("navigation", { name: "分区" }).getByRole("link", { name: "设置", exact: true }).click();
          await page.getByLabel("语言").selectOption("en");
          await page.goto(objectUrl);
          await expect(nameControl).toBeVisible();
        }
      } finally { rmSync(inputDirectory, { recursive: true, force: true }); }
      if (width === 360) {
        const menu = page.getByRole("button", { name: "Menu", exact: true });
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("dialog", { name: "Sections", exact: true }).getByRole("link", { name: "Overview", exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
        const resizeHash = new URL(page.url()).hash;
        for (const switchedWidth of [768, 1280, 1440]) {
          await page.setViewportSize({ width: switchedWidth, height: 800 });
          await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
          if (switchedWidth < 900) await expect(page.getByRole("dialog", { name: "Sections", exact: true })).toBeVisible();
          else await expect(page.getByRole("dialog", { name: "Sections", exact: true })).toHaveCount(0);
          await expect.poll(() => new URL(page.url()).hash).toBe(resizeHash);
          await assertWidth(page, `redesign-resize-open-${theme.toLowerCase()}`, switchedWidth);
        }
        await page.setViewportSize({ width: 360, height: 800 });
        await expect(menu).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("dialog", { name: "Sections", exact: true })).toHaveCount(0);
        await expect(page.locator("aside#console-navigation")).toHaveCount(0);
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
        await expect(menu).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();
        for (const switchedWidth of [768, 1440, 360]) {
          await page.setViewportSize({ width: switchedWidth, height: 800 });
          await expect(page.getByRole("main")).toBeVisible();
          await expect.poll(() => new URL(page.url()).hash).toBe(resizeHash);
          await assertWidth(page, `redesign-resize-closed-${theme.toLowerCase()}`, switchedWidth);
        }
        await expect(menu).toHaveAttribute("aria-expanded", "false");
        await navigate(page, "Settings");
        await page.getByLabel("Current password").fill("unsaved-browser-draft");
        await openNavigation(page);
        page.once("dialog", (dialog) => dialog.dismiss());
        await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
        await expect(page.getByLabel("Current password")).toHaveValue("unsaved-browser-draft");
        await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeVisible();
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
        await expect(menu).toHaveAttribute("aria-expanded", "false");
      }
      const removedObject = await page.request.delete(`/api/buckets/${bucket.id}/objects/preview.txt`, { headers });
      expect(removedObject.ok()).toBe(true);
      } finally {
        if (previewUploaded) {
          for (const key of extraKeys) {
            const cleanup = await page.request.delete(`/api/buckets/${bucket.id}/objects/${key}`, { headers });
            expect([200, 204, 404]).toContain(cleanup.status());
          }
          const objectCleanup = await page.request.delete(`/api/buckets/${bucket.id}/objects/preview.txt`, { headers });
          expect([200, 204, 404]).toContain(objectCleanup.status());
        }
        const removedBucket = await page.request.delete(`/api/buckets/${bucket.id}`, { headers });
        expect(removedBucket.ok()).toBe(true);
        const removedKey = await page.request.delete(`/api/keys/${keyId}`, { headers });
        expect(removedKey.ok()).toBe(true);
        console.log("fixture cleanup", { bucketId: bucket.id, keyId, bucketStatus: removedBucket.status(), keyStatus: removedKey.status() });
      }
    });
  }
}

test("creation stays collapsed and long object prefix remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
  await navigate(page, "Buckets");
  const create = page.getByRole("button", { name: "Create bucket", exact: true });
  await expect(create).not.toBeVisible();
  const measured = await page.locator("[hidden]").evaluateAll((items) => items.map((element) => ({ tag: element.tagName, class: element.className, display: getComputedStyle(element).display })));
  console.log("hidden creation styles", measured);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  const headers = { "x-csrf-token": csrf };
  const response = await page.request.post("/api/buckets", { headers, data: { globalAlias: `e2e-redesign-${Date.now().toString(36)}` } });
  expect(response.ok()).toBe(true);
  const bucket = await response.json() as { id: string };
  try {
    const prefix = "long-prefix-" + "a".repeat(160);
    await page.evaluate(({ id, prefix }) => { location.hash = `#buckets/${id}/${prefix}/`; }, { id: bucket.id, prefix });
    await expect(page.locator("section[aria-label=\"Objects\"]")).toBeVisible();
    const breadcrumb = page.getByRole("navigation", { name: "Prefix", exact: true }).getByRole("button", { name: `${prefix} (${prefix}/)`, exact: true });
    await expect(breadcrumb).toBeVisible();
    console.log("prefix metrics", await breadcrumb.evaluate((element) => ({ width: element.getBoundingClientRect().width, whiteSpace: getComputedStyle(element).whiteSpace, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })));
    await expect(page.locator("main [aria-busy=true]")).toHaveCount(0, { timeout: 20_000 });
    await assertWidth(page, "redesign-long-object-prefix", 360);
    await accessibility(page, "redesign-long-object-prefix");
  } finally {
    const deleted = await page.request.delete(`/api/buckets/${bucket.id}`, { headers });
    expect(deleted.ok()).toBe(true);
    console.log("long-prefix fixture cleanup", { bucketId: bucket.id, bucketStatus: deleted.status() });
  }
});
