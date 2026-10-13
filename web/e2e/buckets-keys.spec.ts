import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { administrator } from "./accounts";
import { evidenceDir, recordLayout } from "./layout";

type ListMode = "live" | "empty" | "error";

test("administers buckets and keys from the pages", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now().toString(36);
  const alpha = `e2e-257-alpha-${stamp}`;
  const zeta = `e2e-257-zeta-${stamp}`;
  const extra = `e2e-257-extra-${stamp}`;
  const keyName = `e2e-257-key-${stamp}`;
  const renamed = `e2e-257-renamed-${stamp}`;
  let keyId = "";

  try {
    await logIn(page);
    await openList(page, "Buckets");
    const buckets = page.getByRole("region", { name: "Buckets" });

    await createBucket(page, alpha);
    await createBucket(page, zeta);
    const alphaRow = await revealRow(buckets, alpha);
    const zetaRow = await revealRow(buckets, zeta);
    await expect(alphaRow.getByText(alpha, { exact: true })).toBeVisible();
    await expect(zetaRow.getByText(zeta, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Light", exact: true }).click();
    await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await recordLayout(page, "buckets-list");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: `${evidenceDir}/buckets-list-light.png`, fullPage: true });
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.screenshot({ path: `${evidenceDir}/buckets-list-dark.png`, fullPage: true });

    const bucketId = await buttonId(
      alphaRow.getByRole("button", { name: /^Objects for / }).innerText(),
      "Objects for ",
    );
    await alphaRow.getByLabel(`Global alias for ${bucketId}`).fill(extra);
    await alphaRow.getByRole("button", { name: `Add alias to ${bucketId}`, exact: true }).click();
    await expect(alphaRow.getByText(extra, { exact: true })).toBeVisible({ timeout: 20_000 });
    await alphaRow.getByRole("button", { name: `Remove global alias ${extra}`, exact: true }).click();
    await expect(alphaRow.getByText(extra, { exact: true })).toHaveCount(0);
    await expect(alphaRow.getByText(alpha, { exact: true })).toBeVisible();

    const objects = alphaRow.getByLabel(`Max objects for ${bucketId}`);
    const size = alphaRow.getByLabel(`Max size for ${bucketId}`);
    const firstQuota = page.waitForRequest(isQuotaPut);
    await objects.fill("17");
    await alphaRow.getByRole("button", { name: `Save quotas for ${bucketId}`, exact: true }).click();
    const firstBody = (await firstQuota).postData() ?? "";
    expect(firstBody).toContain('"maxObjects":17');
    await expect(alphaRow.getByText(/Object quota 17|of 17 objects/)).toBeVisible({ timeout: 20_000 });
    await expect(objects).toHaveValue("17");
    await size.fill("2048");
    await expect(size).toHaveValue("2048");
    const secondQuota = page.waitForRequest(isQuotaPut);
    await alphaRow.getByRole("button", { name: `Save quotas for ${bucketId}`, exact: true }).click();
    const secondBody = (await secondQuota).postData() ?? "";
    expect(secondBody).toContain('"maxSize":2048');
    expect(secondBody).toContain('"maxObjects":17');
    await expect(objects).toHaveValue("17", { timeout: 20_000 });
    await expect(size).toHaveValue("2048");
    await expect(alphaRow.getByText(/Object quota 17|of 17 objects/)).toBeVisible();
    await expect(alphaRow.getByText(/Size quota 2048|of 2048 bytes/)).toBeVisible();

    await openList(page, "Keys");
    keyId = await createKey(page, keyName);
    await openList(page, "Buckets");
    const granted = await revealRow(page.getByRole("region", { name: "Buckets" }), alpha);
    await grantThenRevoke(page, granted, bucketId, keyId);

    const bucketFilter = stamp;
    const bucketList = page.getByRole("region", { name: "Buckets" });
    await bucketList.getByLabel("Filter buckets").fill(bucketFilter);
    await bucketList.getByLabel("Sort buckets").selectOption("alias");
    await expect(page).toHaveURL(new RegExp(`buckets=${bucketFilter}`));
    await expect(page).toHaveURL(/bucketsSort=alias/);
    await expect(bucketList.locator("tbody tr").nth(0)).toContainText(alpha);
    await expect(bucketList.locator("tbody tr").nth(1)).toContainText(zeta);
    await page.reload();
    await expect(bucketList.getByLabel("Filter buckets")).toHaveValue(bucketFilter);
    await expect(bucketList.getByLabel("Sort buckets")).toHaveValue("alias");
    await expect(bucketList.locator("tbody tr").nth(0)).toContainText(alpha, { timeout: 20_000 });
    await expect(bucketList.locator("tbody tr").nth(1)).toContainText(zeta, { timeout: 20_000 });

    const miss = `e2e-257-missing-${stamp}`;
    await bucketList.getByLabel("Filter buckets").fill(miss);
    await expect(bucketList.locator("tbody tr")).toHaveCount(0);
    await page.reload();
    await expect(bucketList.getByLabel("Filter buckets")).toHaveValue(miss);
    await expect(bucketList.getByLabel("Sort buckets")).toHaveValue("alias");
    await expect(bucketList.locator("tbody tr")).toHaveCount(0);
    await recordLayout(page, "buckets-filtered");
    await page.setViewportSize({ width: 1280, height: 800 });

    await bucketList.getByLabel("Filter buckets").fill(bucketFilter);
    await deleteBucket(page, alpha);
    await deleteBucket(page, zeta);

    const bucketMode: { current: ListMode } = { current: "empty" };
    await installListRoute(page, "/api/buckets", bucketMode, {
      code: "buckets_unavailable",
      message: "Buckets are unavailable",
    });
    await page.reload();
    await expect(
      bucketList.getByText("There are no buckets. Create the first bucket.", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await recordLayout(page, "buckets-empty");
    await page.setViewportSize({ width: 1280, height: 800 });

    bucketMode.current = "error";
    await page.reload();
    await expect(bucketList.getByText("Buckets are unavailable", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(bucketList.getByText("buckets_unavailable", { exact: true })).toBeVisible();
    const bucketRetry = bucketList.getByRole("button", { name: "Retry", exact: true });
    await expect(bucketRetry).toBeVisible();
    await recordLayout(page, "buckets-error");
    await page.setViewportSize({ width: 1280, height: 800 });
    bucketMode.current = "live";
    await bucketRetry.click();
    await expect(bucketList.getByText("buckets_unavailable", { exact: true })).toHaveCount(0);
    await expect(bucketList.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    await openList(page, "Keys");
    const keys = page.getByRole("region", { name: "Keys" });
    const keyRow = await revealRow(keys, keyId);
    await keyRow.getByLabel(`Name for ${keyId}`).fill(renamed);
    await keyRow.getByRole("button", { name: `Rename ${keyId}`, exact: true }).click();
    await expect(keys.getByText("Key renamed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(keys.getByRole("cell", { name: renamed, exact: true })).toBeVisible();
    const allow = keys.getByRole("checkbox", { name: `Allow create bucket for ${keyId}` });
    await allow.click();
    await expect(allow).toBeChecked({ timeout: 20_000 });

    await keys.getByLabel("Filter keys").fill(renamed);
    await keys.getByLabel("Sort keys").selectOption("name");
    await expect(page).toHaveURL(new RegExp(`keys=${renamed}`));
    await expect(page).toHaveURL(/keysSort=name/);
    await page.reload();
    await expect(keys.getByLabel("Filter keys")).toHaveValue(renamed);
    await expect(keys.getByLabel("Sort keys")).toHaveValue("name");
    await expect(keys.getByRole("cell", { name: renamed, exact: true })).toBeVisible();
    await expect(keys.getByRole("checkbox", { name: `Allow create bucket for ${keyId}` })).toBeChecked();
    await recordLayout(page, "keys-list");
    await page.setViewportSize({ width: 1280, height: 800 });

    await viewSecretThenClose(page, keyId);
    await deleteKey(page, keyId);

    const keyMiss = `e2e-257-missing-${stamp}`;
    await keys.getByLabel("Filter keys").fill(keyMiss);
    await expect(keys.locator("tbody tr")).toHaveCount(0);
    await page.reload();
    await expect(keys.getByLabel("Filter keys")).toHaveValue(keyMiss);
    await expect(keys.getByLabel("Sort keys")).toHaveValue("name");
    await expect(keys.locator("tbody tr")).toHaveCount(0);
    await recordLayout(page, "keys-filtered");
    await page.setViewportSize({ width: 1280, height: 800 });

    const keyMode: { current: ListMode } = { current: "empty" };
    await installListRoute(page, "/api/keys", keyMode, {
      code: "keys_unavailable",
      message: "Keys are unavailable",
    });
    await page.reload();
    await expect(keys.getByText("There are no keys. Create the first key.", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await recordLayout(page, "keys-empty");
    await page.setViewportSize({ width: 1280, height: 800 });

    keyMode.current = "error";
    await page.reload();
    await expect(keys.getByText("Keys are unavailable", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(keys.getByText("keys_unavailable", { exact: true })).toBeVisible();
    const keyRetry = keys.getByRole("button", { name: "Retry", exact: true });
    await expect(keyRetry).toBeVisible();
    await recordLayout(page, "keys-error");
    await page.setViewportSize({ width: 1280, height: 800 });
    keyMode.current = "live";
    await keyRetry.click();
    await expect(keys.getByText("keys_unavailable", { exact: true })).toHaveCount(0);
    await expect(keys.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  } finally {
    await cleanup(page, [alpha, zeta, extra], keyId).catch(() => undefined);
  }
});

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

async function openList(page: Page, name: "Buckets" | "Keys"): Promise<void> {
  const pathname = name === "Buckets" ? "/api/buckets" : "/api/keys";
  const pending = page.waitForRequest(
    (request) => request.method() === "GET" && listedWithLimit(request, pathname),
  );
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
  const request = await pending;
  expect(new URL(request.url()).searchParams.get("limit")).toMatch(/^[1-9][0-9]*$/);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

function isQuotaPut(request: Request): boolean {
  return request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/quotas");
}

function listedWithLimit(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return url.pathname === pathname && url.searchParams.has("limit");
}

async function createBucket(page: Page, alias: string): Promise<void> {
  await page.getByLabel("Global alias", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "Create bucket", exact: true }).click();
  await expect(page.getByText("Bucket created", { exact: true })).toBeVisible({ timeout: 20_000 });
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

async function grantThenRevoke(page: Page, row: Locator, bucketId: string, keyId: string): Promise<void> {
  await row.getByRole("button", { name: `Permissions for ${bucketId}`, exact: true }).click();
  const grant = row.getByRole("form", { name: `Grant permissions on ${bucketId}` });
  await grant.getByLabel("Access key").fill(keyId);
  await grant.getByRole("checkbox", { name: "Read", exact: true }).check();
  await grant.getByRole("button", { name: "Grant", exact: true }).click();
  const perms = row.getByRole("region", { name: `Permissions for ${bucketId}` });
  await expect(perms.getByText("read yes", { exact: true })).toBeVisible({ timeout: 20_000 });
  await perms.getByRole("button", { name: `Revoke ${keyId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Confirm ${keyId}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(perms.getByRole("button", { name: `Revoke ${keyId}`, exact: true })).toHaveCount(0);
  await expect(perms.getByText("read yes", { exact: true })).toHaveCount(0);
}

async function deleteBucket(page: Page, alias: string): Promise<void> {
  if (!alias.startsWith("e2e-257-")) {
    throw new Error("refusing to delete a bucket outside the e2e-257 prefix");
  }
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  const bucketId = await buttonId(row.getByRole("button", { name: /^Objects for / }).innerText(), "Objects for ");
  await row.getByRole("button", { name: `Delete ${bucketId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Delete bucket ${bucketId}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Delete bucket", exact: true }).click();
  await expect(page.getByText("Bucket deleted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(buckets.getByText(alias, { exact: true })).toHaveCount(0);
}

async function createKey(page: Page, name: string): Promise<string> {
  await page.getByLabel("Key name").fill(name);
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const heading = page.getByRole("heading", { name: /^Secret for / });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  const keyId = (await heading.innerText()).replace(/^Secret for /, "");
  const field = page.getByLabel("Secret access key");
  await expect(field).toHaveAttribute("type", "password");
  const secret = await field.inputValue();
  expect(secret.length).toBeGreaterThan(8);
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectSecretAbsent(page, secret);
  await expect(page.getByRole("region", { name: "Keys" }).getByText(name, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  return keyId;
}

async function viewSecretThenClose(page: Page, keyId: string): Promise<void> {
  const secretRequest = page.waitForRequest((request) => {
    if (request.method() !== "POST") {
      return false;
    }
    return new URL(request.url()).pathname.endsWith("/secret");
  });
  await page.getByRole("button", { name: `View secret for ${keyId}`, exact: true }).click();
  const confirmTitle = page.getByRole("heading", { name: `Confirm ${keyId}` });
  const secretTitle = page.getByRole("heading", { name: `Secret for ${keyId}` });
  await expect(confirmTitle.or(secretTitle)).toBeVisible({ timeout: 20_000 });
  if (await confirmTitle.isVisible()) {
    await expect(page.getByLabel("Secret access key")).toHaveCount(0);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
  }
  const sent = await secretRequest;
  expect(sent.headers()["x-confirm"]).toBe("yes");
  await expect(secretTitle).toBeVisible();
  const field = page.getByLabel("Secret access key");
  await expect(field).toHaveAttribute("type", "password");
  const secret = await field.inputValue();
  expect(secret.length).toBeGreaterThan(8);
  const readable = await page.locator("body").evaluate((body, value) => body.innerText.includes(value), secret);
  expect(readable).toBe(false);
  await page.getByRole("button", { name: "Show secret", exact: true }).click();
  await expect(field).toHaveAttribute("type", "text");
  const shown = await field.evaluate(
    (node, value) => (node as HTMLInputElement).value === value,
    secret,
  );
  expect(shown).toBe(true);
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectSecretAbsent(page, secret);
}

async function expectSecretAbsent(page: Page, secret: string): Promise<void> {
  const present = await page.locator("body").evaluate((body, value) => {
    if (body.innerText.includes(value)) {
      return true;
    }
    for (const node of body.querySelectorAll("input, textarea")) {
      if ((node as HTMLInputElement).value.includes(value)) {
        return true;
      }
    }
    return false;
  }, secret);
  expect(present).toBe(false);
}

async function deleteKey(page: Page, keyId: string): Promise<void> {
  const keys = page.getByRole("region", { name: "Keys" });
  await keys.getByLabel("Filter keys").fill(keyId);
  const row = await revealRow(keys, keyId);
  await row.getByRole("button", { name: `Delete ${keyId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Confirm ${keyId}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Key deleted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(keys.getByRole("cell", { name: keyId, exact: true })).toHaveCount(0);
}

async function installListRoute(
  page: Page,
  pathname: "/api/buckets" | "/api/keys",
  mode: { current: ListMode },
  error: { code: string; message: string },
): Promise<void> {
  await page.route(`**${pathname}?*`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== pathname || mode.current === "live") {
      await route.continue();
      return;
    }
    if (mode.current === "empty") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], hasMore: false }),
      });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(error),
    });
  });
}

async function cleanup(page: Page, aliases: string[], keyId: string): Promise<void> {
  if (page.isClosed()) {
    return;
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.keyboard.press("Escape").catch(() => undefined);
  const bucketsLink = page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
    name: "Buckets",
    exact: true,
  });
  if ((await bucketsLink.count()) === 0) {
    return;
  }
  await bucketsLink.click();
  const buckets = page.getByRole("region", { name: "Buckets" });
  await expect(buckets.getByRole("heading", { name: "Buckets" })).toBeVisible({ timeout: 10_000 });
  const filter = buckets.getByLabel("Filter buckets");
  for (const alias of aliases) {
    if (!alias.startsWith("e2e-257-")) {
      continue;
    }
    await filter.fill(alias);
    const row = buckets.locator("tbody tr", { hasText: alias });
    if ((await row.count()) === 0) {
      continue;
    }
    const bucketId = await buttonId(
      row.first().getByRole("button", { name: /^Objects for / }).innerText(),
      "Objects for ",
    );
    await row.first().getByRole("button", { name: `Delete ${bucketId}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete bucket", exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
  }
  if (keyId.length === 0) {
    return;
  }
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Keys", exact: true }).click();
  const keys = page.getByRole("region", { name: "Keys" });
  await expect(keys.getByRole("heading", { name: "Keys" })).toBeVisible({ timeout: 20_000 });
  await keys.getByLabel("Filter keys").fill(keyId);
  const keyRow = keys.locator("tbody tr", { hasText: keyId });
  if ((await keyRow.count()) === 0) {
    return;
  }
  await keyRow.first().getByRole("button", { name: `Delete ${keyId}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(keyRow).toHaveCount(0, { timeout: 20_000 });
}
