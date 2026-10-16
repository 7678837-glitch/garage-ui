import { submitLogin } from "./login";
import { assertAuthenticated, bucketIdFromRow, chooseTheme, openNavigation, openRowActions, openUpload, selectChoice } from "./interactions";
import { expect, type Locator, type Page, type Request as BrowserRequest, test } from "@playwright/test";
import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { evidenceDir, recordLayout } from "./layout";

const multipartFloor = 64 * 1024 * 1024;
const wideSize = multipartFloor + 1;
const slowSize = 8 * 1024 * 1024;
const note = "prefix-note-258";
const blockedBody = "<p>blocked</p>";

test("browses, previews, transfers, and deletes objects", async ({ page }) => {
  test.setTimeout(600_000);
  const stamp = Date.now().toString(36);
  const alias = `e2e-258-${stamp}`;
  const keyName = `e2e-258-key-${stamp}`;
  const work = mkdtempSync(join(tmpdir(), "e2e-258-"));
  const notesRoot = join(work, "notes");
  const goneRoot = join(work, "gone");
  mkdirSync(notesRoot, { recursive: true });
  mkdirSync(goneRoot, { recursive: true });
  writeFileSync(join(notesRoot, "a.txt"), note);
  writeFileSync(join(goneRoot, "leaf.txt"), "leaf");
  writeFileSync(join(work, "blocked.html"), blockedBody);
  writeFileSync(join(work, "keep-a.txt"), "keep-a");
  writeFileSync(join(work, "keep-b.txt"), "keep-b");
  writeFileSync(join(work, "once.txt"), "once");
  writeFileSync(join(work, "batch-a.txt"), "batch-a");
  writeFileSync(join(work, "batch-b.txt"), "batch-b");
  writeFileSync(join(work, "aa-large.txt"), "A".repeat(200));
  writeFileSync(join(work, "zz-small.txt"), "zz");
  writeSparse(join(work, "slow.bin"), slowSize);
  writeSparse(join(work, "guard.bin"), slowSize);
  writeSparse(join(work, "wide.bin"), wideSize);

  let bucketId = "";
  let keyId = "";
  const objects = page.locator("section[aria-label=\"Objects\"]");
  const upload = page.getByRole("region", { name: "Upload" });

  try {
    page.setDefaultTimeout(30_000);
    await logIn(page);
    bucketId = await createBucket(page, alias);
    keyId = await createKey(page, keyName);
    await grantKey(page, alias, bucketId, keyId);
    await openObjects(page, bucketId);
    await bindKey(objects, keyId);

    await test.step("prefix, inline text, and download", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose folder").setInputFiles(notesRoot);
      await expect(uploadRow(upload, "notes/a.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
      await objects.getByRole("button", { name: "notes/", exact: true }).click();
      const prefixNav = objects.getByRole("navigation", { name: "Prefix" });
      await expect(prefixNav.getByRole("button", { name: "notes (notes/)", exact: true })).toBeVisible();
      // Directory pickers can omit MIME types; explicitly type the inline-preview fixture.
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from(note) });
      await uploadRow(upload, "a.txt").last().getByRole("button", { name: "Overwrite", exact: true }).click();
      await expect(uploadRow(upload, "a.txt").last().getByText("Done", { exact: true })).toBeVisible();
      await objects.getByRole("checkbox", { name: "Select notes/a.txt" }).click();
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toBeVisible();
      const details = objects.getByRole("region", { name: "Object details" });
      await expect(details).toContainText("text/plain");
      await expect(details.locator("pre")).toHaveText(note);
      const href = await objects.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
      const params = new URL(href ?? "", "http://127.0.0.1").searchParams;
      expect(params.get("key")).toBe("notes/a.txt");
      expect(params.get("download")).toBe("1");
      const downloaded = await page.request.get(href ?? "");
      expect(downloaded.status()).toBe(200);
      expect(Buffer.from(await downloaded.body())).toEqual(Buffer.from(note));
      await prefixNav.getByRole("button", { name: `Root (${bucketId})`, exact: true }).click();
      await expect(objects.getByRole("button", { name: "notes/", exact: true })).toBeVisible();
    });

    await test.step("a type outside the allowlist offers Download without an inline preview", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles(join(work, "blocked.html"));
      await expect(uploadRow(upload, "blocked.html").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
      await objects.getByRole("checkbox", { name: "Select blocked.html" }).click();
      const href = await objects.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
      expect(href).toContain("blocked.html");
      expect(href).toContain("download=1");
      const details = objects.getByRole("region", { name: "Object details" });
      await expect(details).toContainText("text/html");
      await expect(details.locator("pre, img, video, audio, iframe")).toHaveCount(0);
      await expect(details).not.toContainText(blockedBody);
      await objects.getByRole("checkbox", { name: "Select blocked.html" }).click();
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
    });

    await test.step("upload three files and cancel one", async () => {
      const slowUpload = await pauseUpload(page, bucketId, "slow.bin");
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles([
        join(work, "keep-a.txt"),
        join(work, "keep-b.txt"),
        join(work, "slow.bin"),
      ]);
      await slowUpload.started;
      const slow = uploadRow(upload, "slow.bin");
      await expect(slow.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const guardedHash = new URL(page.url()).hash;
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true }).click();
      await expect.poll(() => new URL(page.url()).hash).toBe(guardedHash);
      await expect(slow.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      await slow.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(slow.getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(slow.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await slowUpload.resume();
      await expect(uploadRow(upload, "keep-a.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(uploadRow(upload, "keep-b.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(slow.getByText("Cancelled", { exact: true })).toBeVisible();
      await expect(objects.getByRole("button", { name: "keep-a.txt", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(objects.getByRole("button", { name: "keep-b.txt", exact: true })).toBeVisible();
      await expect(objects.getByRole("button", { name: "slow.bin", exact: true })).toHaveCount(0);
      const missing = await page.request.get(objectUrl(bucketId, "slow.bin"));
      expect(missing.status()).toBe(404);
      expect(await multipartKeys(page, bucketId)).not.toContain("slow.bin");
    });

    await test.step("accepted upload departure cancels real transfer", async () => {
      const guardedUpload = await pauseUpload(page, bucketId, "guard.bin");
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles(join(work, "guard.bin"));
      await guardedUpload.started;
      await expect(uploadRow(upload, "guard.bin").getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
      await guardedUpload.resume();
      await openObjects(page, bucketId);
      await expect(objects.getByRole("button", { name: "keep-a.txt", exact: true })).toBeVisible();
      const missing = await page.request.get(objectUrl(bucketId, "guard.bin"));
      expect(missing.status()).toBe(404);
      expect(await multipartKeys(page, bucketId)).not.toContain("guard.bin");
    });

    await test.step("delete one object", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles(join(work, "once.txt"));
      await expect(uploadRow(upload, "once.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await objects.getByRole("checkbox", { name: "Select once.txt" }).click();
      await objects.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Confirm once.txt" })).toBeVisible();
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "once.txt", exact: true })).toHaveCount(0);
    });

    await test.step("batch delete asks for the count", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles([
        join(work, "batch-a.txt"),
        join(work, "batch-b.txt"),
      ]);
      await expect(uploadRow(upload, "batch-a.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(uploadRow(upload, "batch-b.txt").getByText("Done", { exact: true })).toBeVisible();
      await clearSelection(objects);
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
      await objects.getByRole("checkbox", { name: "Select batch-a.txt" }).click();
      await objects.getByRole("checkbox", { name: "Select batch-b.txt" }).click();
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toBeVisible();
      await objects.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Confirm 2" })).toBeVisible();
      const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel("Type 2 to confirm").fill("2");
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "batch-a.txt", exact: true })).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "batch-b.txt", exact: true })).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
    });

    await test.step("recursive delete types the prefix", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose folder").setInputFiles(goneRoot);
      await expect(uploadRow(upload, "gone/leaf.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      const folder = objects.locator("tbody tr", { hasText: "gone/" });
      await expect(folder.getByRole("button", { name: "gone/", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await openRowActions(folder);
      await page.getByRole("menuitem", { name: "Delete folder (gone/)", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Confirm gone/" })).toBeVisible();
      const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel("Type gone/ to confirm").fill("gone/");
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "gone/", exact: true })).toHaveCount(0);
      const leaf = await page.request.get(objectUrl(bucketId, "gone/leaf.txt"));
      expect(leaf.status()).toBe(404);
    });

    await test.step("a file above the multipart threshold uploads as multipart", async () => {
      const widePath = join(work, "wide.bin");
      expect(statSync(widePath).size).toBe(wideSize);
      const captured: { status: number; body: string } = { status: 0, body: "" };
      const wideRoute = (url: URL) => url.pathname.endsWith("/object") && url.searchParams.get("key") === "wide.bin";
      await page.route(wideRoute, async (route) => {
        const request = route.request();
        if (request.method() !== "PUT") {
          await route.continue();
          return;
        }
        const url = new URL(request.url());
        const headers = await request.allHeaders();
        // WebKit interception happens before Cookie is attached to the request.
        headers.cookie = (await page.context().cookies(request.url())).map(({ name, value }) => `${name}=${value}`).join("; ");
        const result = await putFile(widePath, `${url.pathname}${url.search}`, headers);
        captured.status = result.status;
        captured.body = result.body;
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          body: result.body,
        });
      });
      try {
        await openUpload(objects);
        await objects.getByLabel("Choose files").setInputFiles(widePath);
        await expect(uploadRow(upload, "wide.bin").getByText("Done", { exact: true })).toBeVisible({
          timeout: 60_000,
        });
      } finally {
        await page.unroute(wideRoute);
      }
      expect(captured.status).toBe(201);
      const body = JSON.parse(captured.body) as { key?: string; etag?: string; size?: number };
      expect(body.key).toBe("wide.bin");
      expect(body.size).toBe(wideSize);
      expect(body.etag).toMatch(/^[0-9a-f]+-[1-9][0-9]*$/);
      expect(await multipartKeys(page, bucketId)).not.toContain("wide.bin");
      const wideRow = objects.locator("tbody tr", { hasText: "wide.bin" });
      await expect(wideRow).toContainText(String(wideSize), { timeout: 20_000 });
      await wideRow.getByRole("checkbox", { name: "Select wide.bin" }).click();
      await objects.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Confirm wide.bin" })).toBeVisible();
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(objects.getByRole("button", { name: "wide.bin", exact: true })).toHaveCount(0);
    });

    await test.step("screenshots, empty list, and error", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles([
        join(work, "aa-large.txt"),
        join(work, "zz-small.txt"),
      ]);
      await expect(uploadRow(upload, "aa-large.txt").getByText("Done", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(objects.getByRole("button", { name: "zz-small.txt", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await chooseTheme(page, "Light");
      await recordLayout(page, "objects-list");
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({ path: `${evidenceDir}/objects-list-light.png`, fullPage: true });
      await chooseTheme(page, "Dark");
      await page.screenshot({ path: `${evidenceDir}/objects-list-dark.png`, fullPage: true });

      const mode: { current: "live" | "empty" | "error" } = { current: "empty" };
      await page.route(objectListPattern(bucketId), async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET" || !url.pathname.endsWith("/objects") || mode.current === "live") {
          await route.continue();
          return;
        }
        if (mode.current === "empty") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              prefix: url.searchParams.get("prefix") ?? "",
              entries: [],
              next: null,
            }),
          });
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "objects_unavailable",
            message: "Objects are unavailable",
          }),
        });
      });
      await page.reload();
      await expect(
        objects.getByText("There are no objects. Upload the first object.", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(objects.getByRole("button", { name: "Copy path", exact: true })).toHaveCount(0);
      await recordLayout(page, "objects-empty");
      await page.setViewportSize({ width: 1280, height: 800 });

      mode.current = "error";
      await page.reload();
      await expect(objects.getByText("Objects are unavailable", { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(objects.getByText("objects_unavailable", { exact: true })).toBeVisible();
      const retry = objects.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible();
      await recordLayout(page, "objects-error");
      await page.setViewportSize({ width: 1280, height: 800 });
      mode.current = "live";
      await retry.click();
      await expect(objects.getByText("objects_unavailable", { exact: true })).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "zz-small.txt", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    await test.step("filter and sort stay after refresh", async () => {
      await expect(objects.getByLabel("Sort")).toHaveText("Key");
      let order = await listedKeys(objects);
      expect(order.indexOf("aa-large.txt")).toBeLessThan(order.indexOf("zz-small.txt"));
      await selectChoice(objects.getByLabel("Sort"), "Size");
      await expect(objects.getByText("Only this page", { exact: true })).toBeVisible();
      order = await listedKeys(objects);
      expect(order.indexOf("zz-small.txt")).toBeLessThan(order.indexOf("aa-large.txt"));
      await objects.getByLabel("Search").fill("zz-small");
      await objects.getByRole("button", { name: "Search", exact: true }).click();
      await expect(objects.getByRole("button", { name: "zz-small.txt", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(objects.getByRole("button", { name: "aa-large.txt", exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/objects=zz-small/);
      await expect(page).toHaveURL(/objectsSort=size/);
      await page.reload();
      await expect(objects.getByLabel("Search")).toHaveValue("zz-small");
      await expect(objects.getByLabel("Sort")).toHaveText("Size");
      await expect(objects.getByText("Only this page", { exact: true })).toBeVisible();
      await expect(objects.getByRole("button", { name: "zz-small.txt", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(objects.getByRole("button", { name: "aa-large.txt", exact: true })).toHaveCount(0);
    });

    await test.step("active search refreshes after upload and deletion", async () => {
      await openUpload(objects);
      await objects.getByLabel("Choose files").setInputFiles({ name: "zz-small-new.txt", mimeType: "text/plain", buffer: Buffer.from("new search match") });
      await expect(objects.getByRole("button", { name: "zz-small-new.txt", exact: true })).toBeVisible();
      await expect(objects.getByLabel("Search")).toHaveValue("zz-small");
      await objects.getByRole("checkbox", { name: "Select zz-small-new.txt", exact: true }).click();
      await objects.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "zz-small-new.txt", exact: true })).toHaveCount(0);
      await expect(objects.getByRole("button", { name: "zz-small.txt", exact: true })).toBeVisible();
    });

    await deleteBucketThroughThePage(page, alias, bucketId);
  } finally {
    rmSync(work, { recursive: true, force: true });
    await release(page, alias, bucketId, keyId).catch(() => undefined);
  }
});

function writeSparse(path: string, size: number): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, Buffer.from([1]), 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
}

function uploadRow(upload: Locator, name: string): Locator {
  return upload.getByRole("listitem").filter({ hasText: name });
}

function objectUrl(bucketId: string, key: string): string {
  return `/api/buckets/${encodeURIComponent(bucketId)}/object?key=${encodeURIComponent(key)}`;
}

function objectListPattern(bucketId: string): string {
  return `**/api/buckets/${encodeURIComponent(bucketId)}/objects?*`;
}

async function listedKeys(objects: Locator): Promise<string[]> {
  return objects.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => row.querySelector("button.ui-object-name")?.textContent ?? ""),
  );
}

async function clearSelection(objects: Locator): Promise<void> {
  const checked = objects.getByRole("checkbox", { checked: true });
  while ((await checked.count()) > 0) {
    await checked.first().click();
  }
}

function putFile(
  filePath: string,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const size = statSync(filePath).size;
  const sent: Record<string, string> = { "content-length": String(size) };
  for (const name of ["cookie", "content-type", "x-csrf-token"]) {
    const value = headers[name];
    if (value) {
      sent[name] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 3909,
        path: pathname,
        method: "PUT",
        headers: sent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    createReadStream(filePath).on("error", reject).pipe(req);
  });
}

async function multipartKeys(page: Page, bucketId: string): Promise<string[]> {
  const response = await page.request.get(`/api/buckets/${encodeURIComponent(bucketId)}/multipart`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { uploads?: { key?: string }[] };
  return (body.uploads ?? []).flatMap((upload) => (upload.key ? [upload.key] : []));
}

async function pauseUpload(page: Page, bucketId: string, key: string): Promise<{ started: Promise<void>; resume: () => Promise<void> }> {
  const pathname = `/api/buckets/${encodeURIComponent(bucketId)}/object`;
  const matcher = (url: URL) => url.pathname === pathname && url.searchParams.get("key") === key;
  let release!: () => void;
  let markStarted!: () => void;
  let intercepted!: BrowserRequest;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(matcher, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    intercepted = route.request();
    markStarted();
    await paused;
  });
  return {
    started,
    async resume() {
      await expect.poll(() => intercepted.failure(), { timeout: 15_000 }).not.toBeNull();
      release();
      await page.unroute(matcher);
    },
  };
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
  await assertAuthenticated(page);
}

async function createBucket(page: Page, alias: string): Promise<string> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await expect(page.getByText("Bucket created", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("dialog", { name: "Create bucket", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  return bucketIdFromRow(row);
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

async function grantKey(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
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
}

async function openObjects(page: Page, bucketId: string): Promise<void> {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByRole("button", { name: `Open objects (${bucketId})`, exact: true }).click();
  await expect(page.locator("section[aria-label=\"Objects\"]")).toBeVisible();
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

async function revealRow(scope: Locator, text: string): Promise<Locator> {
  const row = scope.locator("tbody tr", { hasText: text });
  await expect(async () => {
    if ((await row.count()) > 0) {
      return;
    }
    const more = scope.getByRole("button", { name: "Load more", exact: true });
    if (await more.isVisible()) {
      await more.click();
    }
    expect(await row.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  return row.first();
}


async function deleteBucketThroughThePage(page: Page, alias: string, bucketId: string): Promise<void> {
  if (!alias.startsWith("e2e-258-") || bucketId.length === 0) {
    throw new Error("refusing to delete a bucket outside this run");
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await emptyBucket(page, bucketId);
  if (await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true }).isVisible()) {
    await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "Buckets", exact: true }).click();
  } else {
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  }
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible({ timeout: 20_000 });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  await openRowActions(row);
  await page.getByRole("menuitem", { name: `Delete ${bucketId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Delete bucket ${bucketId}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Delete bucket", exact: true }).click();
  await expect(page.getByText("Bucket deleted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(buckets.getByText(alias, { exact: true })).toHaveCount(0);
}

async function release(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  if (page.isClosed() || !alias.startsWith("e2e-258-")) {
    return;
  }
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  if (bucketId.length > 0) {
    await emptyBucket(page, bucketId).catch(() => undefined);
    const headers = await csrfHeader(page);
    await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}/multipart`, {
      headers,
      data: "{}",
    });
    await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}`, { headers });
  }
  if (keyId.length > 0) {
    const headers = await csrfHeader(page);
    await page.request.delete(`/api/keys/${encodeURIComponent(keyId)}`, { headers });
  }
}

async function emptyBucket(page: Page, bucketId: string): Promise<void> {
  const headers = await csrfHeader(page);
  await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}/multipart`, {
    headers,
    data: "{}",
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const listed = await page.request.get(
      `/api/buckets/${encodeURIComponent(bucketId)}/objects?prefix=&limit=100`,
    );
    if (listed.status() === 412) {
      return;
    }
    if (listed.status() !== 200) {
      throw new Error(`object list failed with status ${listed.status()}`);
    }
    const body = (await listed.json()) as { entries?: { kind?: string; prefix?: string; key?: string }[] };
    const entries = body.entries ?? [];
    if (entries.length === 0) {
      return;
    }
    for (const entry of entries) {
      const key = entry.kind === "prefix" ? entry.prefix : entry.key;
      if (!key) {
        throw new Error("object list entry has no key");
      }
      const path =
        entry.kind === "prefix" ? `${objectUrl(bucketId, key)}&recursive=true` : objectUrl(bucketId, key);
      const removed = await page.request.delete(path, { headers });
      if (removed.status() !== 200 && removed.status() !== 204) {
        throw new Error(`object delete failed with status ${removed.status()}`);
      }
    }
  }
  throw new Error("bucket still has objects");
}

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies("http://127.0.0.1:3909");
  const value = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  return { "x-csrf-token": value };
}
