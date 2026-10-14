/** Browser receipt for large-file-check.sh; run with the existing web Playwright dependency. */
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { chromium, expect } = await import("../web/node_modules/@playwright/test/index.mjs");
if (process.argv[2] === "--check") {
  accessSync(chromium.executablePath(), constants.X_OK);
  console.log("browser_prerequisites=ready");
  process.exit(0);
}
const [origin, work] = process.argv.slice(2);
if (!origin || !work || new URL(origin).hostname !== "127.0.0.1") {
  throw new Error("Usage: bun scripts/large-file-browser.ts http://127.0.0.1:port evidence-directory");
}
const bucket = readFileSync(join(work, "bucket_id"), "utf8").trim();
const expectedPaths = new Set(Array.from({ length: 100 }, (_, i) =>
  `/api/buckets/${encodeURIComponent(bucket)}/objects/thumbnails/t${String(i).padStart(3, "0")}.jpg?thumbnail=1`,
));
const cookies = readFileSync(join(work, "cookies"), "utf8").split("\n")
  .filter((line) => line.startsWith("#HttpOnly_") || (line.length > 0 && !line.startsWith("#")))
  .map((line) => {
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    return { name: fields[5], value: fields[6], url: origin, httpOnly: line.startsWith("#HttpOnly_") };
  }).filter((cookie) => ["garage_session", "garage_csrf"].includes(cookie.name));
if (cookies.length !== 2) throw new Error("Expected session and CSRF cookies from the harness login");
const browser = await chromium.launch({ headless: true });
const network: { path: string; status: number; content_type: string }[] = [];
let decoded = 0;
let passed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies(cookies);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("response", (response) => {
    const url = new URL(response.url());
    const path = `${url.pathname}${url.search}`;
    if (expectedPaths.has(path)) {
      network.push({ path, status: response.status(), content_type: response.headers()["content-type"] ?? "" });
    }
  });
  await page.goto(`${origin}/#buckets/${encodeURIComponent(bucket)}/thumbnails/`);
  const objects = page.getByRole("region", { name: "Objects", exact: true });
  await expect(objects).toBeVisible();
  const images = objects.locator("tbody img");
  await expect(images).toHaveCount(100, { timeout: 180_000 });
  await expect.poll(async () => images.evaluateAll((nodes) => nodes.filter((node) =>
    node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
  ).length), { timeout: 180_000 }).toBe(100);
  decoded = await images.evaluateAll(async (nodes) => {
    await Promise.all(nodes.map((node) => (node as HTMLImageElement).decode()));
    return nodes.filter((node) => node instanceof HTMLImageElement && node.naturalWidth > 0).length;
  });
  for (let i = 0; i < 100; i++) {
    await images.nth(i).scrollIntoViewIfNeeded();
    await expect(images.nth(i)).toBeVisible();
  }
  const served = new Set(network.filter((row) => row.status === 200 && row.content_type.startsWith("image/")).map((row) => row.path));
  if (decoded !== 100 || served.size !== 100 || network.some((row) => row.status !== 200)) {
    throw new Error(`Thumbnail browser receipt failed: decoded=${decoded}, image_responses=${served.size}`);
  }
  await page.screenshot({ path: join(work, "browser.png"), fullPage: true });
  passed = true;
} finally {
  const receipt = {
    passed, decoded_images: decoded,
    image_responses: new Set(network.filter((row) => row.status === 200 && row.content_type.startsWith("image/")).map((row) => row.path)).size,
    screenshot: passed ? "browser.png" : null, network,
  };
  writeFileSync(join(work, "browser.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(`browser decoded_images=${decoded} image_responses=${receipt.image_responses} pass=${passed}`);
  await browser.close();
}
