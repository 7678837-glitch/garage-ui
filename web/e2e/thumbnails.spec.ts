import { assertAuthenticated, openAccount, openDisclosure, openNavigation } from "./interactions";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { administrator, readOnlyUser } from "./accounts";
import { assertWidth } from "./layout";

const png = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0,
  0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0,
  201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

test("lists thumbnails for bitmap keys and skips them without download permission", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const stamp = Date.now().toString(36);
  const alias = `e2e-314-${stamp}`;
  const keyName = `e2e-314-key-${stamp}`;
  let bucketId = "";
  let keyId = "";
  const served: string[] = [];
  const viewerThumbs: string[] = [];
  let watchViewer = false;
  page.on("response", (response) => {
    if (response.status() === 200 && new URL(response.url()).searchParams.get("thumbnail") === "1") {
      served.push(response.url());
    }
  });
  page.on("request", (request) => {
    if (watchViewer && new URL(request.url()).searchParams.get("thumbnail") === "1") {
      viewerThumbs.push(request.url());
    }
  });

  try {
    page.setDefaultTimeout(30_000);
    await logIn(page, administrator.username, administrator.password);
    bucketId = await createBucket(page, alias);
    keyId = await createKey(page, keyName);
    await grantKey(page, alias, bucketId, keyId);
    await openObjects(page, bucketId);
    await bindKey(page.locator("section[aria-label=\"Objects\"]"), keyId);
    await putBitmaps(page, bucketId);
    await page.reload();
    const objects = page.locator("section[aria-label=\"Objects\"]");
    await objects.getByRole("button", { name: "pix/", exact: true }).click();
    await expect
      .poll(
        async () =>
          objects.locator("tbody img").evaluateAll((nodes) =>
            nodes.filter((node) => node instanceof HTMLImageElement && node.naturalWidth > 0).length,
          ),
        { timeout: 90_000 },
      )
      .toBe(100);
    expect(new Set(served).size).toBe(100);
    const last = objects.getByRole("button", { name: "pix/100.png", exact: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await last.scrollIntoViewIfNeeded();
    const at360 = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(at360.scrollWidth).toBeLessThanOrEqual(at360.innerWidth);
    await assertWidth(page, "object-thumbnails", 360);
    await assertWidth(page, "object-thumbnails", 1280);

    await objects
      .getByRole("navigation", { name: "Prefix" })
      .getByRole("button", { name: bucketId, exact: true })
      .click();
    await objects.getByRole("button", { name: "bad/", exact: true }).click();
    const badRow = objects.locator("tbody tr", { hasText: "bad/nope.png" });
    await expect(badRow.locator("svg")).toBeVisible({ timeout: 30_000 });
    await expect(badRow.locator("img")).toHaveCount(0);

    watchViewer = true;
    await logOut(page);
    await logIn(page, readOnlyUser.username, readOnlyUser.password);
    await openViewerObjects(page, alias, bucketId);
    const viewer = page.locator("section[aria-label=\"Objects\"]");
    await viewer.getByRole("button", { name: "pix/", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "pix/001.png", exact: true })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "pix/100.png", exact: true })).toBeVisible();
    await expect(viewer.locator("img")).toHaveCount(0);
    await viewer.getByRole("checkbox", { name: "Select pix/001.png", exact: true }).check();
    await expect(viewer.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
    await expect(viewer.getByRole("link", { name: "Preview", exact: true })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(viewerThumbs).toEqual([]);
    await page.setViewportSize({ width: 360, height: 800 });
    await viewer.getByRole("button", { name: "pix/100.png", exact: true }).scrollIntoViewIfNeeded();
    const viewerWidth = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(viewerWidth.scrollWidth).toBeLessThanOrEqual(viewerWidth.innerWidth);
    await assertWidth(page, "object-thumbnails-viewer", 360);
    await assertWidth(page, "object-thumbnails-viewer", 1280);
  } finally {
    await release(page, alias, bucketId, keyId);
  }
});

async function putBitmaps(page: Page, bucketId: string): Promise<void> {
  const headers = await csrfHeader(page);
  const files: { key: string; body: Buffer; type: string }[] = [];
  for (let index = 1; index <= 100; index += 1) {
    const name = String(index).padStart(3, "0");
    files.push({ key: `pix/${name}.png`, body: png, type: "image/png" });
  }
  files.push({ key: "bad/nope.png", body: Buffer.from("not-a-png"), type: "image/png" });
  for (let index = 0; index < files.length; index += 8) {
    const slice = files.slice(index, index + 8);
    await Promise.all(slice.map((file) => putObject(page, bucketId, file, headers)));
  }
}

async function putObject(
  page: Page,
  bucketId: string,
  file: { key: string; body: Buffer; type: string },
  headers: Record<string, string>,
): Promise<void> {
  const response = await page.request.put(objectUrl(bucketId, file.key), {
    data: file.body,
    headers: {
      ...headers,
      "content-type": file.type,
      "content-length": String(file.body.length),
    },
  });
  if (response.status() !== 201) {
    throw new Error(`put ${file.key} failed with status ${response.status()}`);
  }
}

async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
}

async function logOut(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Overview", exact: true }).click();
  await openAccount(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
}

async function createBucket(page: Page, alias: string): Promise<string> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await expect(page.getByText("Bucket created", { exact: true })).toBeVisible({ timeout: 20_000 });
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  return buttonId(row.getByRole("button", { name: /^Objects for / }).getAttribute("aria-label").then((label) => label ?? ""), "Objects for ");
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
  await row.getByRole("button", { name: `Permissions for ${bucketId}`, exact: true }).click();
  await openDisclosure(page.locator("summary", { hasText: "Grant key" }));
  const grant = page.getByRole("form", { name: `Grant permissions on ${bucketId}` });
  await grant.getByLabel("Access key").fill(keyId);
  await grant.getByRole("checkbox", { name: "Read", exact: true }).check();
  await grant.getByRole("checkbox", { name: "Write", exact: true }).check();
  await grant.getByRole("checkbox", { name: "Owner", exact: true }).check();
  await grant.getByRole("button", { name: "Grant", exact: true }).click();
  await expect(page.getByRole("region", { name: `Permissions for ${bucketId}` }).getByText("write yes", { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function openObjects(page: Page, bucketId: string): Promise<void> {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByRole("button", { name: `Objects for ${bucketId}`, exact: true }).click();
  await expect(page.locator("section[aria-label=\"Objects\"]")).toBeVisible();
}

async function openViewerObjects(page: Page, alias: string, bucketId: string): Promise<void> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
  await row.getByRole("button", { name: `Objects for ${bucketId}`, exact: true }).click();
  await expect(page.locator("section[aria-label=\"Objects\"]")).toBeVisible();
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

async function buttonId(label: Promise<string>, prefix: string): Promise<string> {
  return (await label).replace(prefix, "");
}

function objectUrl(bucketId: string, key: string): string {
  return `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeKey(key)}`;
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies("http://127.0.0.1:3909");
  const value = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  return { "x-csrf-token": value };
}

async function release(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  if (page.isClosed() || !alias.startsWith("e2e-314-")) {
    return;
  }
  await page.goto("/").catch(() => undefined);
  const logout = page.getByRole("button", { name: "Log out", includeHidden: true });
  if (await logout.count() > 0) {
    await openAccount(page);
    await logout.click();
  }
  const username = page.getByLabel("Username");
  if (await username.isVisible().catch(() => false)) {
    await username.fill(administrator.username);
    await page.getByLabel("Password").fill(administrator.password);
    await page.getByRole("button", { name: "Log in" }).click();
  }
  await expect(page.getByRole("button", { name: "Log out", includeHidden: true }), "fixture cleanup requires an authenticated administrator").toHaveCount(1);
  const headers = await csrfHeader(page);
  if (bucketId.length > 0) {
    for (const prefix of ["pix/", "bad/"]) {
      await page.request
        .delete(`${objectUrl(bucketId, prefix)}?recursive=true`, { headers })
        .catch(() => undefined);
    }
    await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}`, { headers }).catch(() => undefined);
  }
  if (keyId.length > 0) {
    await page.request.delete(`/api/keys/${encodeURIComponent(keyId)}`, { headers }).catch(() => undefined);
  }
}
