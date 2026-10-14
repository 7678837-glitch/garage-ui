import { submitLogin } from "./login";
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { administrator } from "./accounts";
import { assertRenderedLayout } from "./layout";
import { assertAuthenticated, openNavigation, openDisclosure, openRowActions, bucketIdFromRow, selectChoice } from "./interactions";

const evidence = process.env.STORAGE_EVIDENCE_DIR ?? "/tmp/garage-ui-allpages-storage";
mkdirSync(evidence, { recursive: true });
const matrix: unknown[] = existsSync(`${evidence}/matrix.json`) ? JSON.parse(readFileSync(`${evidence}/matrix.json`, "utf8")) : [];
const prefix = "e2e-allpages-storage-";
async function login(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
  await assertAuthenticated(page);
}
async function nav(page: Page, name: "Buckets" | "Keys") {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
async function api(page: Page, path: string, method = "GET", data?: unknown) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(c => c.name === "garage_csrf");
  const response = await page.request.fetch(path, { method, data, headers: { "x-csrf-token": decodeURIComponent(csrf?.value ?? ""), "x-confirm": "yes" } });
  expect(response.ok(), `${method} ${path} status`).toBe(true);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function seed(page: Page, grant = false, selectCredential = false) {
  const name = `${prefix}${Date.now().toString(36)}`;
  const bucket = await api(page, "/api/buckets", "POST", { globalAlias: name });
  const key = await api(page, "/api/keys", "POST", { name });
  const keyId = key.accessKeyId ?? key.id;
  if (grant) await api(page, `/api/buckets/${bucket.id}/permissions`, "POST", { accessKeyId: keyId, permissions: { owner: true, read: true, write: true } });
  if (selectCredential) await api(page, `/api/buckets/${bucket.id}/credential`, "PUT", { access_key_id: keyId });
  return { name, bucketId: bucket.id, keyId };
}
async function cleanup(page: Page, fixture: { name: string; bucketId: string; keyId: string }) {
  if (!fixture.name.startsWith(prefix)) throw new Error("Unowned cleanup fixture");
  const bucket = await api(page, `/api/buckets/${fixture.bucketId}`);
  expect(JSON.stringify(bucket)).toContain(fixture.name);
  await api(page, `/api/buckets/${fixture.bucketId}`, "DELETE");
  const key = await api(page, `/api/keys/${fixture.keyId}`);
  expect(key.name).toMatch(new RegExp(`^${prefix}`));
  await api(page, `/api/keys/${fixture.keyId}`, "DELETE");
}
async function shot(page: Page, name: string, actions: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await assertRenderedLayout(page, name);
  const geometry = await page.evaluate(() => {
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); return e.checkVisibility() && r.width > 0 && r.height > 0; };
    const rect = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, width: r.width, height: r.height, bottom: r.bottom }; };
    return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
      header: rect(document.querySelector(".console-topbar")),
      headings: [...document.querySelectorAll("main h2")].filter(visible).map(e => ({ text: e.textContent, ...rect(e) })),
      tabs: rect(document.querySelector('[role="tablist"]')),
      firstAction: rect([...document.querySelectorAll("main button, main input, main summary")].find(visible) ?? null),
      controls: [...document.querySelectorAll("main input, main textarea, main button, main summary, [role=tab], [role=dialog] input, [role=dialog] textarea, [role=dialog] button")].filter(visible).map(e => ({ label: e.getAttribute("aria-label") ?? e.closest("label")?.textContent?.trim() ?? e.textContent?.trim(), tag: e.tagName, role: e.getAttribute("role"), type: e.getAttribute("type"), font: getComputedStyle(e).fontSize, ...rect(e) })) };
  });
  const path = `${evidence}/${name}-${geometry.width}.png`;
  await page.screenshot({ path, fullPage: true, mask: [page.getByLabel("Secret access key")] });
  await page.screenshot({ path: `${evidence}/${name}-${geometry.width}-top.png`, fullPage: false, mask: [page.getByLabel("Secret access key")] });
  writeFileSync(`${evidence}/${name}-${geometry.width}.json`, JSON.stringify(geometry, null, 2));
  matrix.push({ page: name, viewport: `${geometry.width}x800`, actions, result: "operated", screenshot: path, geometry });
  writeFileSync(`${evidence}/matrix.json`, JSON.stringify(matrix, null, 2));
  expect.soft(geometry.overflow, `${name}: horizontal overflow`).toBeLessThanOrEqual(0);
  if (geometry.width === 360) {
    for (const control of geometry.controls) {
      if (control.tag === "INPUT" && !["checkbox", "radio"].includes(control.type ?? "")) {
        expect.soft(parseFloat(control.font), `${name}: ${control.label} readable font`).toBeGreaterThanOrEqual(16);
        expect.soft(control.width, `${name}: ${control.label} usable width`).toBeGreaterThanOrEqual(180);
      }
      if (["BUTTON", "SUMMARY", "A"].includes(control.tag) && !["checkbox", "radio"].includes(control.role ?? "")) expect.soft(control.height, `${name}: ${control.label} touch height`).toBeGreaterThanOrEqual(36);
    }
  }
}
async function tab(page: Page, name: string) { await page.getByRole("tab", { name, exact: true }).click(); await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true"); }

for (const width of [1280, 360]) {
  test(`storage list create and actions at ${width}`, async ({ page }) => {
    await login(page, width);
    const name = `${prefix}list-${width}-${Date.now().toString(36)}`;
    let bucketId = ""; let keyId = "";
    try {
      await nav(page, "Buckets");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await shot(page, "buckets-create", "Opened create form");
      await page.getByLabel("Global alias", { exact: true }).fill(name);
      await page.getByRole("button", { name: "Create bucket", exact: true }).click();
      await expect(page.getByText("Bucket created", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByLabel("Filter buckets").fill(name);
      await selectChoice(page.getByLabel("Sort buckets"), "Alias");
      await openDisclosure(page.locator("summary", { hasText: "Only loaded rows" }));
      const row = page.locator("tbody tr", { hasText: name });
      await expect(row).toBeVisible();
      bucketId = await bucketIdFromRow(row);
      await shot(page, "buckets-list", "Created bucket; filtered and sorted alias");
      await openRowActions(row);
      await page.getByRole("menuitem", { name: `Delete ${bucketId}`, exact: true }).click();
      await shot(page, "bucket-delete-confirm", "Opened owned bucket deletion confirmation");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(row).toBeVisible();
      await nav(page, "Keys");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await shot(page, "keys-create", "Opened key create form; source has no import control");
      await page.getByLabel("Key name").fill(name);
      await page.getByRole("button", { name: "Create key", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: /^Secret for / })).toBeVisible();
      keyId = (await dialog.getByRole("heading").innerText()).replace("Secret for ", "");
      const secret = page.getByLabel("Secret access key");
      await expect(secret).toHaveAttribute("type", "password");
      await shot(page, "keys-secret", "Created synthetic key; masked secret dialog");
      await dialog.getByRole("button", { name: "Show secret", exact: true }).click();
      await expect(secret).toHaveAttribute("type", "text");
      await dialog.getByRole("button", { name: "Copy secret", exact: true }).click();
      await expect(dialog.getByText(/Copied|Select the secret and copy it/)).toBeVisible();
      await dialog.getByRole("button", { name: "I have saved it", exact: true }).click();
      await expect(secret).toHaveCount(0);
      await page.getByLabel("Filter keys").fill(name);
      await selectChoice(page.getByLabel("Sort keys"), "Name");
      await openDisclosure(page.locator("summary", { hasText: "Only loaded rows" }));
      const keyRow = page.locator("tbody tr", { hasText: name });
      await expect(keyRow).toBeVisible();
      await shot(page, "keys-list", "Created key; revealed/copied/closed secret; filtered/sorted name");
      await keyRow.getByRole("button", { name: `Delete ${keyId}`, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(keyRow).toBeVisible();
      await keyRow.getByRole("button", { name: `Delete ${keyId}`, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByText("Key deleted", { exact: true })).toBeVisible();
      keyId = "";
      await nav(page, "Buckets");
      await page.getByLabel("Filter buckets").fill(name);
      const deleteRow = page.locator("tbody tr", { hasText: name });
      await openRowActions(deleteRow);
      await page.getByRole("menuitem", { name: `Delete ${bucketId}`, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete bucket", exact: true }).click();
      await expect(page.getByText("Bucket deleted", { exact: true })).toBeVisible();
      bucketId = "";
      await shot(page, "storage-ui-deletion-complete", "Deleted owned key and bucket through UI confirmations; filtered result empty");
    } finally {
      if (bucketId) await api(page, `/api/buckets/${bucketId}`, "DELETE");
      if (keyId) await api(page, `/api/keys/${keyId}`, "DELETE");
    }
  });

  test(`bucket aliases quotas and objects at ${width}`, async ({ page }) => {
    await login(page, width); const fixture = await seed(page, true);
    try {
      await nav(page, "Buckets"); await page.getByLabel("Filter buckets").fill(fixture.name);
      await page.locator("tbody tr", { hasText: fixture.name }).getByRole("link").click();
      await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
      await openDisclosure(page.locator("summary", { hasText: "Full ID" }));
      await expect(page.locator("code").filter({ hasText: fixture.bucketId })).toBeVisible();
      await page.getByRole("button", { name: "Copy ID", exact: true }).click();
      await shot(page, "bucket-overview", "Opened owned bucket via list identity; expanded/copy full ID");
      const listing = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/buckets/${fixture.bucketId}/objects`, { timeout: 30000 });
      await tab(page, "Objects");
      const objectResponse = await listing;
      expect(objectResponse.status(), "New bucket requires explicit credential selection").toBe(412);
      await expect(page.getByRole("combobox", { name: "Bucket key", exact: true })).toBeVisible({ timeout: 15000 });
      await selectChoice(page.getByRole("combobox", { name: "Bucket key", exact: true }), fixture.keyId);
      await shot(page, "bucket-objects-select-key", "Observed real no-usable-key response; selected owned Bucket key");
      const selectedListing = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/buckets/${fixture.bucketId}/objects`, { timeout: 30000 });
      await page.getByRole("button", { name: "Use this key", exact: true }).click();
      expect((await selectedListing).ok(), "Objects list after explicit UI credential selection").toBe(true);
      await expect(page.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible({ timeout: 15000 });
      await page.getByLabel("Search", { exact: true }).fill("missing-object");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByText("There are no objects.", { exact: true })).toBeVisible({ timeout: 15000 });
      await shot(page, "bucket-objects", "Opened Objects tab; owned bucket is genuinely empty");
      await tab(page, "Settings");
      await expect(page.getByRole("button", { name: "Add alias", exact: true })).toBeVisible();
      await shot(page, "bucket-settings", "Opened all settings sections");
      const extra = `${fixture.name}-alias-`.padEnd(63, "a");
      await page.getByRole("button", { name: "Add alias", exact: true }).click();
      await page.getByLabel(`Global alias for ${fixture.bucketId}`).fill(extra);
      await page.getByRole("button", { name: `Add alias to ${fixture.bucketId}`, exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add alias", exact: true }).getByText("Alias added", { exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Add alias", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("button", { name: `Remove global alias ${extra}`, exact: true })).toBeVisible();
      await expect(page.getByText(extra, { exact: true })).toBeVisible();
      await shot(page, "bucket-long-global-alias", "Added long global alias; full identity and removal action remain visible");
      await page.getByRole("button", { name: `Remove global alias ${extra}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `Remove global alias ${extra}`, exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Add alias", exact: true }).click();
      await page.getByRole("radio", { name: `Local for ${fixture.bucketId}`, exact: true }).click();
      await page.getByLabel(`Local alias for ${fixture.bucketId}`).fill(extra);
      await page.getByLabel(`Access key for ${fixture.bucketId}`).fill(fixture.keyId);
      await shot(page, "bucket-local-alias", "Switched global to local; filled owned key alias");
      await page.getByRole("button", { name: `Add alias to ${fixture.bucketId}`, exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add alias", exact: true }).getByText("Alias added", { exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Add alias", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("button", { name: new RegExp(`Remove local alias ${extra}`) })).toBeVisible();
      await expect(page.getByText(extra, { exact: true })).toBeVisible();
      await shot(page, "bucket-long-local-alias", "Added long local alias; full identity and key-specific removal action remain visible");
      await page.getByRole("button", { name: new RegExp(`Remove local alias ${extra}`) }).click();
      const size = page.getByLabel(`Max size for ${fixture.bucketId}`); const objects = page.getByLabel(`Max objects for ${fixture.bucketId}`);
      await objects.fill("-1"); await page.getByRole("button", { name: `Save quotas for ${fixture.bucketId}`, exact: true }).click();
      await expect(page.getByText(/whole|integer/).first()).toBeVisible();
      await objects.fill("17"); await size.fill("2048");
      await page.getByRole("button", { name: `Save quotas for ${fixture.bucketId}`, exact: true }).click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await objects.fill("18");
      page.once("dialog", async dialog => { expect(dialog.message()).toMatch(/unsaved/i); await dialog.dismiss(); });
      await tabAttempt(page, "Overview");
      await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(objects).toHaveValue("18"); await objects.fill("17");
      await shot(page, "bucket-quotas", "Rejected negative quota; saved 17/2048; dismissed dirty navigation and preserved draft");
      const stored = await api(page, `/api/buckets/${fixture.bucketId}`); expect(stored.quotas).toMatchObject({maxObjects:17,maxSize:2048});
      await tab(page, "Overview");
    } finally { await cleanup(page, fixture); }
  });

  test(`bucket permissions and key settings at ${width}`, async ({ page }) => {
    await login(page, width); const fixture = await seed(page);
    try {
      await nav(page, "Buckets"); await page.getByLabel("Filter buckets").fill(fixture.name);
      await page.locator("tbody tr", { hasText: fixture.name }).getByRole("link").click();
      await tab(page, "Permissions"); await page.getByRole("button", { name: "Grant key", exact: true }).click();
      const grant = page.getByRole("form", { name: `Grant permissions on ${fixture.bucketId}` });
      await expect(grant.getByRole("button", { name: "Grant", exact: true })).toBeDisabled();
      await grant.getByLabel("Access key").fill(fixture.keyId);
      await grant.getByRole("checkbox", { name: "Read", exact: true }).click();
      await grant.getByRole("checkbox", { name: "Write", exact: true }).click();
      await shot(page, "bucket-grant", "Opened grant form; disabled empty grant; selected read/write");
      await grant.getByRole("button", { name: "Grant", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Grant key", exact: true }).getByText("Permissions granted", { exact: true })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("dialog", { name: "Grant key", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByText("read yes", { exact: true })).toBeVisible();
      await shot(page, "bucket-permissions", "Granted read/write and saw persisted row");
      await page.getByRole("button", { name: `Revoke ${fixture.keyId}`, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await nav(page, "Keys"); await page.getByLabel("Filter keys").fill(fixture.name);
      await page.locator("tbody tr", { hasText: fixture.name }).getByRole("link").click();
      await openDisclosure(page.locator("summary", { hasText: "Full ID" }));
      await page.getByRole("button", { name: "Copy ID", exact: true }).click();
      await shot(page, "key-overview", "Opened owned key via list identity; expanded/copy full ID");
      await tab(page, "Buckets"); await expect(page.getByText("read yes", { exact: true })).toBeVisible();
      await shot(page, "key-buckets", "Read assigned bucket and read/write grant");
      await tab(page, "Settings");
      await page.getByRole("button", { name: `Actions (${fixture.keyId})`, exact: true }).click();
      const rename = page.getByLabel(`Name for ${fixture.keyId}`);
      await rename.fill(`${fixture.name}-long-readable-name-for-storage-administration`);
      await shot(page, "key-settings", "Opened settings; filled long readable name");
      await page.getByRole("button", { name: `Save name (${fixture.keyId})`, exact: true }).click();
      await expect(page.getByText("Key renamed", { exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Name", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
      const allow = page.getByRole("checkbox", { name: `Allow bucket creation (${fixture.keyId})`, exact: true });
      await allow.click(); await expect(allow).toBeChecked();
      await page.getByRole("button", { name: `View secret for ${fixture.keyId}`, exact: true }).click();
      const confirm = page.getByRole("dialog");
      if (await confirm.getByRole("button", { name: "Confirm", exact: true }).isVisible()) await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByLabel("Secret access key")).toBeVisible();
      await page.getByRole("button", { name: "I have saved it", exact: true }).click();
      await page.getByRole("button", { name: `Delete key (${fixture.keyId})`, exact: true }).click();
      await shot(page, "key-delete-confirm", "Renamed key, enabled bucket creation, viewed synthetic secret, opened delete confirmation");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await nav(page, "Buckets"); await page.getByLabel("Filter buckets").fill(fixture.name);
      await page.locator("tbody tr", { hasText: fixture.name }).getByRole("link").click(); await tab(page, "Permissions");
      await page.getByRole("button", { name: `Revoke ${fixture.keyId}`, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByText("read yes", { exact: true })).toHaveCount(0);
    } finally { await cleanup(page, fixture); }
  });

  test(`bucket CORS lifecycle and cleanup at ${width}`, async ({ page }) => {
    await login(page, width); const fixture = await seed(page, true, true);
    try {
      await nav(page, "Buckets"); await page.getByLabel("Filter buckets").fill(fixture.name);
      await page.locator("tbody tr", { hasText: fixture.name }).getByRole("link").click(); await tab(page, "Settings");
      await page.getByRole("button", { name: "Edit CORS", exact: true }).click();
      await page.getByRole("button", { name: "Add CORS rule", exact: true }).click();
      await page.getByLabel("ID", { exact: true }).fill("storage-rule");
      await page.getByLabel("AllowedOrigin", { exact: true }).fill("https://storage.example");
      await page.getByLabel("AllowedMethod", { exact: true }).fill("GET");
      await shot(page, "bucket-cors-form", "Opened CORS rule fields and entered origin/method");
      await page.getByRole("button", { name: "Review CORS", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save CORS", exact: true })).toBeVisible();
      await shot(page, "bucket-cors-review", "Reviewed current/next CORS diff");
      await page.getByRole("region", { name: "CORS", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save CORS", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Review CORS", exact: true }).click();
      await page.getByRole("button", { name: "Save CORS", exact: true }).click();
      await expect.poll(async () => (await api(page, `/api/buckets/${fixture.bucketId}/cors`)).corsRules?.length).toBe(1);
      await page.getByRole("button", { name: "Edit lifecycle", exact: true }).click();
      await page.getByRole("button", { name: "Add lifecycle rule", exact: true }).click();
      await page.getByLabel("ID", { exact: true }).nth(1).fill("storage-expiry");
      await page.getByLabel("Status", { exact: true }).fill("Enabled");
      await page.getByLabel("Expiration.Days", { exact: true }).fill("7");
      await shot(page, "bucket-lifecycle-form", "Opened lifecycle expiry/retention fields and entered 7 days");
      await page.getByRole("button", { name: "Review lifecycle", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save lifecycle", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Save lifecycle", exact: true }).click();
      await expect.poll(async () => (await api(page, `/api/buckets/${fixture.bucketId}/lifecycle`)).lifecycleRules?.length).toBe(1);
      const multipart = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/buckets/${fixture.bucketId}/multipart`, { timeout: 30000 });
      await page.getByRole("button", { name: "Incomplete uploads", exact: true }).click();
      const multipartResponse = await multipart;
      expect(multipartResponse.ok(), `Multipart response ${multipartResponse.status()}`).toBe(true);
      await expect(page.getByLabel("Older than hours")).toBeVisible({ timeout: 15000 });
      await page.getByLabel("Older than hours").fill("-1"); await expect(page.getByRole("button", { name: "Clean up", exact: true })).toBeDisabled();
      await page.getByLabel("Older than hours").fill("24");
      await shot(page, "bucket-cleanup", "Opened empty owned multipart list; invalid hours disabled cleanup; entered 24 hours");
      await page.getByRole("button", { name: "Clean up", exact: true }).click();
      await expect(page.getByText(/Cleaned up 0/)).toBeVisible();
    } finally { await cleanup(page, fixture); }
  });
}
async function tabAttempt(page: Page, name: string) { await page.getByRole("tab", { name, exact: true }).click(); }
