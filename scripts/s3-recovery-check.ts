/**
 * Live B2 regression: bun scripts/s3-recovery-check.ts
 * Requires the existing v2.4.1 Garage fixture, web dependencies and Chromium.
 * GARAGE_UI_BINARY defaults to this checkout's target/debug/garage-ui.
 * S3_RECOVERY_OUT defaults to /tmp/garage-ui-nine-fixes/runtime.
 * No fixture containers are started, stopped, or deleted.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken, garageTarget } from "../web/e2e/garage-target";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(process.env.GARAGE_UI_BINARY ?? join(root, "target/debug/garage-ui"));
const out = resolve(process.env.S3_RECOVERY_OUT ?? "/tmp/garage-ui-nine-fixes/runtime");
const target = garageTarget();
if (target.version !== "v2.4.1") throw new Error("This check requires Garage v2.4.1");
const token = adminToken(target.container);
const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const alias = `b2-recovery-${suffix}`;
const objectKey = `recovery-${suffix}.txt`;
const objectKeys = [1280, 360].map(width => `${width}-${objectKey}`);
const payload = Buffer.from(`B2 live S3 recovery ${suffix}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(out, { recursive: true, mode: 0o700 });

async function checked(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status}`);
  return response;
}
async function admin(operation: string, body?: unknown, id?: string) {
  const url = new URL(`/v2/${operation}`, target.adminUrl);
  if (id) url.searchParams.set("id", id);
  const response = await checked(url.href, {
    method: body !== undefined || id ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// The native application has a fixed port; select a free loopback address.
async function freeHost() {
  for (const host of ["127.0.0.2", "::1", "127.0.0.1"]) {
    const probe = createServer();
    const available = await new Promise<boolean>(resolve => {
      probe.once("error", () => resolve(false));
      probe.listen(3909, host, () => probe.close(() => resolve(true)));
    });
    if (available) return host;
  }
  throw new Error("No free loopback address at native port 3909");
}

// Only used to remove this check's exact object, even when UI recovery fails.
function signedDelete(url: URL, access: string, secret: string) {
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""), day = date.slice(0, 8);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();
  const empty = hash("");
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const headers = `host:${url.host}\nx-amz-content-sha256:${empty}\nx-amz-date:${date}\n`;
  const scope = `${day}/garage/s3/aws4_request`;
  const canonical = ["DELETE", url.pathname, "", headers, signed, empty].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), "garage"), "s3"), "aws4_request");
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex");
  return { "x-amz-date": date, "x-amz-content-sha256": empty, authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

let healthy = false, failedNodeInfo = 0, successfulNodeInfo = 0;
let translatedCarriers = 0;
const advertisedEndpoints = new Set<string>();
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const incoming = new URL(request.url);
    const nodeInfo = incoming.pathname === "/v2/GetNodeInfo";
    if (nodeInfo && !healthy) {
      failedNodeInfo++;
      return Response.json({ code: "unavailable", message: "Controlled discovery outage" }, { status: 503 });
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(new URL(incoming.pathname + incoming.search, target.adminUrl), {
      method: request.method, headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!nodeInfo || !response.ok) return response;
    const value = await response.json();
    const carriers = value.garageVersion ? [value] : Object.values(value.success ?? {});
    if (!carriers.length) throw new Error("Real GetNodeInfo has no versioned carriers");
    for (const carrier of carriers as any[]) {
      if (!String(carrier.garageVersion).includes("2.4.1")) throw new Error("Fixture version is not v2.4.1");
      const params = carrier.connectionParameters ?? {};
      if (typeof params.s3Endpoint === "string") advertisedEndpoints.add(params.s3Endpoint);
      carrier.connectionParameters = { ...params, s3Endpoint: target.s3Url, s3Region: "garage" };
      translatedCarriers++;
    }
    successfulNodeInfo++;
    return Response.json(value, { status: response.status });
  },
});

const work = mkdtempSync(join(tmpdir(), "garage-ui-b2-"));
let app: ChildProcess | undefined, browser: any, bucketId = "", access = "", secret = "";
const receipt: any = { pass: false, fixture: { version: target.version, container: target.container }, bucketAlias: alias, objectKeys, widths: [], cleanup: {} };
let failure: unknown;
try {
  bucketId = (await admin("CreateBucket", { globalAlias: alias })).id;
  receipt.bucketId = bucketId;
  const host = await freeHost();
  const base = `http://${host.includes(":") ? `[${host}]` : host}:3909`;
  // A fresh working directory and a minimal environment exclude .env and inherited S3 overrides.
  app = spawn(binary, [], {
    cwd: work,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: host, COOKIE_SECURE: "false", DATA_DIR: join(work, "data"), GARAGE_ADMIN_URL: `http://127.0.0.1:${proxy.port}`, GARAGE_ADMIN_TOKEN: token },
    stdio: "ignore",
  });
  let spawnFailure: Error | undefined;
  app.on("error", error => { spawnFailure = error; });
  const pid = app.pid;
  for (let attempt = 0; ; attempt++) {
    if (spawnFailure) throw spawnFailure;
    if (app.exitCode !== null) throw new Error("Native UI exited before readiness");
    try { receipt.health = await (await checked(`${base}/healthz`)).json(); break; }
    catch (error) { if (attempt >= 60) throw error; await sleep(250); }
  }
  receipt.uiPid = pid;
  receipt.uiBase = base;
  const { chromium, expect } = await import("../web/node_modules/@playwright/test/index.mjs");
  const { assertAuthenticated, openUpload } = await import("../web/e2e/interactions");
  browser = await chromium.launch({ headless: true });
  const bootstrap = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const setupPage = await bootstrap.newPage();
  await setupPage.goto(base);
  await setupPage.getByLabel("Username", { exact: true }).fill("recovery-admin");
  await setupPage.getByLabel("Password", { exact: true }).fill(randomBytes(20).toString("hex"));
  await setupPage.getByRole("button", { name: "Create administrator", exact: true }).click();
  await assertAuthenticated(setupPage);
  const csrf = (await bootstrap.cookies()).find((cookie: any) => cookie.name === "garage_csrf")?.value;
  if (!csrf) throw new Error("Real setup session has no CSRF cookie");
  const keyResponse = await bootstrap.request.post(`${base}/api/keys`, { headers: { "x-csrf-token": csrf }, data: { name: `b2-key-${suffix}` } });
  if (!keyResponse.ok()) throw new Error(`Create UI key: HTTP ${keyResponse.status()}`);
  const key = await keyResponse.json();
  access = key.accessKeyId; secret = key.secretAccessKey;
  if (!access || !secret) throw new Error("Real CreateKey response lacks credentials");
  await admin("AllowBucketKey", { bucketId, accessKeyId: access, permissions: { read: true, write: true, owner: true } });
  const bind = await bootstrap.request.put(`${base}/api/buckets/${bucketId}/credential`, { headers: { "x-csrf-token": csrf }, data: { access_key_id: access } });
  if (!bind.ok()) throw new Error(`Bind UI key: HTTP ${bind.status()}`);
  const storageState = await bootstrap.storageState();
  await bootstrap.close();
  const pages: any[] = [];
  const errors: string[] = [];
  for (const width of [1280, 360]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 800 }, locale: "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    const failedList = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api/buckets/${bucketId}/objects` && response.status() === 502);
    await page.goto(`${base}/#buckets/${bucketId}/`);
    const unavailable = await (await failedList).json();
    if (unavailable.code !== "garage_unavailable") throw new Error(`Wrong unavailable code at ${width}px`);
    await expect(page.getByRole("alert").filter({ hasText: /Garage.*not reachable/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Unavailable page overflows at ${width}px`);
    await page.screenshot({ path: join(out, `unavailable-${width}.png`), fullPage: true });
    pages.push({ page, width, unavailableStatus: 502, unavailableCode: unavailable.code });
  }
  if (failedNodeInfo < 1 || successfulNodeInfo !== 0) throw new Error("Discovery outage was not exercised");
  // Register before restoring discovery: automatic query retries can win the race with a click.
  for (const entry of pages) {
    entry.recovered = entry.page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api/buckets/${bucketId}/objects` && response.status() === 200)
      .then((response: any) => ({ response }), (error: Error) => ({ error }));
  }
  healthy = true;
  await Promise.all(pages.map(async entry => {
    const retry = entry.page.getByRole("button", { name: "Retry", exact: true });
    entry.recovery = "automatic";
    if (await retry.isVisible()) {
      try { await retry.click({ timeout: 3000 }); entry.recovery = "clickedRetry"; }
      catch { /* A real successful response below must prove recovery if the button disappears. */ }
    }
    const result = await entry.recovered;
    if (result.error) throw result.error;
    const body = await result.response.json();
    if (body.prefix !== "" || !Array.isArray(body.entries) || !(body.next === null || typeof body.next === "string")) throw new Error(`Invalid recovered object list at ${entry.width}px`);
    entry.recoveredStatus = result.response.status();
    await expect(entry.page.getByRole("alert").filter({ hasText: /Garage.*not reachable/i })).toHaveCount(0);
  }));
  for (const { page, width, recovery, recoveredStatus, unavailableStatus, unavailableCode } of pages) {
    const widthObjectKey = `${width}-${objectKey}`;
    const objects = page.getByRole("region", { name: "Objects", exact: true });
    await openUpload(objects);
    await objects.getByLabel("Choose files", { exact: true }).setInputFiles({ name: widthObjectKey, mimeType: "text/plain", buffer: payload });
    await expect(page.getByRole("region", { name: "Upload", exact: true }).getByText("Done", { exact: true })).toBeVisible();
    await expect(objects.getByRole("checkbox", { name: `Select ${widthObjectKey}`, exact: true })).toBeVisible();
    await objects.getByRole("checkbox", { name: `Select ${widthObjectKey}`, exact: true }).click();
    const href = await objects.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
    if (!href) throw new Error("Recovered object has no download link");
    const download = await page.request.get(new URL(href, base).href);
    if (!download.ok() || !Buffer.from(await download.body()).equals(payload)) throw new Error(`Downloaded bytes differ at ${width}px`);
    await expect(page.getByRole("alert").filter({ hasText: /Garage.*not reachable/i })).toHaveCount(0);
    if (app.pid !== pid || app.exitCode !== null) throw new Error("UI process restarted or exited");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Recovered page overflows at ${width}px`);
    await page.screenshot({ path: join(out, `recovered-${width}.png`), fullPage: true });
    receipt.widths.push({ width, unavailable: true, unavailableStatus, unavailableCode, recovery, recoveredStatus, objectKey: widthObjectKey, byteExactDownload: true, overflow });
  }
  if (!successfulNodeInfo || errors.length) throw new Error("Missing successful discovery or browser errors");
  const finalHealth = await (await checked(`${base}/healthz`)).json();
  if (JSON.stringify(finalHealth) !== JSON.stringify(receipt.health)) throw new Error("UI build identity changed");
  receipt.sameUiProcess = true;
  receipt.payloadSha256 = createHash("sha256").update(payload).digest("hex");
  receipt.pass = true;
} catch (error) {
  failure = error;
} finally {
  healthy = true;
  const cleanupErrors: string[] = [];
  if (browser) await browser.close().catch(() => cleanupErrors.push("Browser close failed"));
  if (app && app.exitCode === null) {
    const stopped = new Promise<void>(resolve => app!.once("exit", () => resolve()));
    app.kill("SIGTERM");
    await Promise.race([stopped, sleep(5000)]);
    if (app.exitCode === null) { app.kill("SIGKILL"); await stopped; }
  }
  if (bucketId && access && secret) {
    receipt.cleanup.objects = [];
    for (const ownKey of objectKeys) {
      try {
        const url = new URL(`/${alias}/${ownKey}`, target.s3Url);
        await checked(url.href, { method: "DELETE", headers: signedDelete(url, access, secret) });
        receipt.cleanup.objects.push(ownKey);
      } catch { cleanupErrors.push(`Exact object deletion failed: ${ownKey}`); }
    }
  }
  if (bucketId) {
    try { await admin("DeleteBucket", undefined, bucketId); receipt.cleanup.bucket = true; }
    catch { cleanupErrors.push("Exact bucket deletion failed"); }
  }
  if (access) {
    try { await admin("DeleteKey", undefined, access); receipt.cleanup.key = true; }
    catch { cleanupErrors.push("Exact key deletion failed"); }
  }
  proxy.stop(true);
  rmSync(work, { recursive: true, force: true });
  receipt.cleanup.temporaryData = true;
  receipt.discovery = { failedNodeInfo, successfulNodeInfo, translatedCarriers, fixtureTranslation: { advertisedEndpoints: [...advertisedEndpoints], serverReachableEndpoint: target.s3Url, region: "garage" } };
  receipt.cleanup.errors = cleanupErrors;
  if (cleanupErrors.length) receipt.pass = false;
  writeFileSync(join(out, "summary.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  if (cleanupErrors.length && !failure) failure = new Error(cleanupErrors.join("; "));
}
console.log(JSON.stringify({ pass: receipt.pass, summary: join(out, "summary.json") }));
if (failure) throw failure;
