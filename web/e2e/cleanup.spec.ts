import { assertAuthenticated, openDisclosure, openNavigation } from "./interactions";
import { createHash, createHmac, type BinaryLike } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { garageTarget } from "./garage-target";
import { assertWidth } from "./layout";

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const region = "garage";

test("cleans up incomplete uploads older than the threshold", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const alias = `e2e-277-${stamp}`;
  const keyName = `e2e-277-key-${stamp}`;
  const objectKey = `e2e-277-pending-${stamp}`;
  let bucketId = "";
  let keyId = "";

  try {
    page.setDefaultTimeout(30_000);
    await logIn(page);
    bucketId = await createBucket(page, alias);
    const created = await createKey(page, keyName);
    keyId = created.keyId;
    await grantKey(page, alias, bucketId, keyId);
    await openObjects(page, bucketId);
    await bindKey(page.locator("section[aria-label=\"Objects\"]"), keyId);
    const uploadId = await createIncompleteUpload(bucketId, objectKey, keyId, created.secret);
    await backToBuckets(page);

    const buckets = page.getByRole("region", { name: "Buckets" });
    await buckets.getByLabel("Filter buckets").fill(alias);
    const row = await revealRow(buckets, alias);
    await openDisclosure(row.locator("summary[aria-label^=\"Edit \"]"));
    await row.getByRole("button", { name: "Incomplete uploads", exact: true }).click();
    await expect(row.getByText(objectKey, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(uploadId, { exact: true })).toBeVisible();
    await assertWidth(page, "cleanup-uploads", 1280);
    await assertWidth(page, "cleanup-uploads", 360);

    // A new upload is already older than zero seconds. The field accepts whole hours, so 0 removes it.
    await row.getByLabel("Older than hours").fill("0");
    await expect(row.getByRole("button", { name: "Clean up", exact: true })).toBeEnabled();
    const pending = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === `/api/buckets/${bucketId}/cleanup-uploads`;
    });
    await row.getByRole("button", { name: "Clean up", exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { uploadsDeleted?: unknown };
    expect(body.uploadsDeleted).toBe(1);
    await expect(row.getByText(objectKey, { exact: true })).toHaveCount(0);
    await expect(row.getByText(uploadId, { exact: true })).toHaveCount(0);
    await expect(row.getByText(`Cleaned up ${body.uploadsDeleted}`, { exact: true })).toBeVisible();
    await assertWidth(page, "cleanup-uploads-after", 360);
    await assertWidth(page, "cleanup-uploads-after", 1280);

    await deleteBucketThroughThePage(page, alias, bucketId);
    bucketId = "";
  } finally {
    await release(page, alias, bucketId, keyId);
  }
});

async function createIncompleteUpload(
  bucketId: string,
  objectKey: string,
  accessKeyId: string,
  secret: string,
): Promise<string> {
  const endpoint = new URL(garageTarget().s3Url);
  const host = endpoint.port.length > 0 ? `${endpoint.hostname}:${endpoint.port}` : endpoint.hostname;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const canonicalUri = `/${awsEncode(bucketId)}/${awsEncode(objectKey)}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["POST", canonicalUri, "uploads=", canonicalHeaders, signedHeaders, emptyHash].join("\n");
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(secret, amzDate.slice(0, 8), region, "s3"))
    .update(stringToSign)
    .digest("hex");
  const response = await fetch(`${endpoint.origin}${canonicalUri}?uploads`, {
    method: "POST",
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": emptyHash,
      "x-amz-date": amzDate,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`create multipart upload failed with status ${response.status}: ${text.slice(0, 300)}`);
  }
  const uploadId = text.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) {
    throw new Error("create multipart upload returned no upload id");
  }
  return uploadId;
}

function signingKey(secret: string, date: string, area: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, area);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function hmac(key: BinaryLike, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await assertAuthenticated(page);
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

async function createKey(page: Page, name: string): Promise<{ keyId: string; secret: string }> {
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Keys", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keys", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Key name").fill(name);
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const heading = page.getByRole("heading", { name: /^Secret for / });
  await expect(heading).toBeVisible({ timeout: 20_000 });
  const keyId = (await heading.innerText()).replace(/^Secret for /, "");
  const secret = await page.getByLabel("Secret access key").inputValue();
  expect(secret.length).toBeGreaterThan(8);
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return { keyId, secret };
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

async function bindKey(objects: Locator, keyId: string): Promise<void> {
  const picker = objects.getByLabel("Bucket key");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker.locator("option", { hasText: keyId })).toHaveCount(1, { timeout: 20_000 });
  await picker.selectOption(keyId);
  await objects.getByRole("button", { name: "Use this key", exact: true }).click();
  await expect(objects.getByText("There are no objects. Upload the first object.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}

async function backToBuckets(page: Page): Promise<void> {
  await page.locator("section[aria-label=\"Objects\"]").getByRole("button", { name: "Back to buckets", exact: true }).click();
  await expect(page.getByRole("region", { name: "Buckets" }).getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
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

async function deleteBucketThroughThePage(page: Page, alias: string, bucketId: string): Promise<void> {
  if (!alias.startsWith("e2e-277-") || bucketId.length === 0) {
    throw new Error("refusing to delete a bucket outside the e2e-277 prefix");
  }
  const buckets = page.getByRole("region", { name: "Buckets" });
  await buckets.getByLabel("Filter buckets").fill(alias);
  const row = await revealRow(buckets, alias);
  await row.getByRole("button", { name: `Delete ${bucketId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Delete bucket ${bucketId}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Delete bucket", exact: true }).click();
  await expect(page.getByText("Bucket deleted", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(buckets.getByText(alias, { exact: true })).toHaveCount(0);
}

async function release(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  if (page.isClosed() || !alias.startsWith("e2e-277-")) {
    return;
  }
  const headers = await csrfHeader(page);
  if (bucketId.length > 0) {
    await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}/multipart`, {
      headers,
      data: "{}",
    });
    const removed = await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}`, { headers });
    if (removed.status() !== 200 && removed.status() !== 204 && removed.status() !== 404) {
      throw new Error(`bucket delete failed with status ${removed.status()}`);
    }
  }
  if (keyId.length > 0) {
    const removed = await page.request.delete(`/api/keys/${encodeURIComponent(keyId)}`, { headers });
    if (removed.status() !== 200 && removed.status() !== 204 && removed.status() !== 404) {
      throw new Error(`key delete failed with status ${removed.status()}`);
    }
  }
}

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies("http://127.0.0.1:3909");
  const value = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  return { "x-csrf-token": value };
}
