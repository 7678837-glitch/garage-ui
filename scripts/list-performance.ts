/**
 * Real Garage list acceptance check. Run with Bun after `bun install` in web/:
 * bun scripts/list-performance.ts seed /tmp/garage-list-performance
 * bun scripts/list-performance.ts measure /tmp/garage-list-performance /path/to/current/garage-ui
 * bun scripts/list-performance.ts cleanup /tmp/garage-list-performance
 * seed creates exactly 10,000 buckets and 100,000 zero-byte .txt objects under perf/.
 * measure uses authenticated fresh Chromium contexts, navigation start to the first
 * visible list data row, three runs per list (maximum <= 2,000 ms). No mocks.
 * Cleanup removes only the uniquely named container and volume recorded by seed.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [mode, directory, binary] = process.argv.slice(2);
if (!directory || !["seed", "measure", "cleanup"].includes(mode)) throw new Error("Usage: bun scripts/list-performance.ts seed|measure|cleanup evidence-directory [binary]");
const work = resolve(directory);
mkdirSync(work, { recursive: true, mode: 0o700 });
const statePath = join(work, "fixture.json");
const bucketCount = 10_000, objectCount = 100_000;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const save = (name: string, value: unknown) => writeFileSync(join(work, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const disk = () => {
  const bytes = Number(execFileSync("df", ["-k", "/System/Volumes/Data"], { encoding: "utf8" }).trim().split("\n").at(-1)!.split(/\s+/)[3]) * 1024;
  if (bytes < 8 * 1024 ** 3) throw new Error(`Disk below 8 GiB: ${bytes} available bytes`);
  return bytes;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seedTransientErrors = 0;
async function checked(url: string, options: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(new URL(url).pathname === "/healthz" ? 1000 : 60_000) });
    if (response.ok) return response;
    await response.arrayBuffer();
    if (mode === "seed" && response.status === 503 && attempt < 5) {
      seedTransientErrors++;
      console.log(JSON.stringify({ seedTransientErrors, status: 503, attempt: attempt + 1 }));
      await sleep(250 * (attempt + 1));
      continue;
    }
    throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status}`);
  }
}
async function pool(count: number, action: (index: number) => Promise<void>) {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < count) {
      const index = next++;
      await action(index);
      done++;
      if (done % 5_000 === 0) console.log(JSON.stringify({ progress: done, total: count, availableBytes: disk() }));
    }
  }));
}
function sign(method: string, url: URL, access: string, secret: string) {
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""), day = date.slice(0, 8);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();
  const contentHash = hash("");
  const headers = `host:${url.host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${date}\n`;
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const query = Array.from(url.searchParams).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [method, url.pathname, query, headers, signed, contentHash].join("\n");
  const scope = `${day}/garage/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), "garage"), "s3"), "aws4_request");
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex");
  return { "x-amz-date": date, "x-amz-content-sha256": contentHash, authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
if (mode === "seed") {
  // A state file must never be overwritten: its resource identities are the cleanup boundary.
  try { readFileSync(statePath); throw new Error("Fixture already exists; choose a fresh evidence directory"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const suffix = `${process.pid}-${Date.now()}`;
  const fixture: any = { container: `garage-ui-perf-${suffix}`, volume: `garage-ui-perf-${suffix}`, admin: "http://127.0.0.1:3973", s3: "http://127.0.0.1:3970", token: randomBytes(32).toString("hex"), availableBytes: disk() };
  fixture.image = docker("image", "inspect", "dxflrs/garage:v2.4.1", "--format", "{{.Id}}");
  save("fixture.json", fixture);
  writeFileSync(join(work, "garage.toml"), `metadata_dir = "/data/meta"\ndata_dir = "/data/objects"\ndb_engine = "sqlite"\nreplication_factor = 1\nrpc_bind_addr = "[::]:3901"\nrpc_public_addr = "127.0.0.1:3901"\nrpc_secret = "${randomBytes(32).toString("hex")}"\n[s3_api]\ns3_region = "garage"\napi_bind_addr = "[::]:3900"\nroot_domain = ".s3.garage.localhost"\n[admin]\napi_bind_addr = "[::]:3903"\nadmin_token = "${fixture.token}"\n`, { mode: 0o600 });
  docker("volume", "create", fixture.volume);
  docker("run", "-d", "--pull", "never", "--name", fixture.container, "--log-opt", "max-size=10m", "--log-opt", "max-file=1", "-p", "127.0.0.1:3973:3903", "-p", "127.0.0.1:3970:3900", "-v", `${fixture.volume}:/data`, "-v", `${join(work, "garage.toml")}:/etc/garage.toml:ro`, "dxflrs/garage:v2.4.1", "/garage", "server", "--single-node");
  for (let i = 0; ; i++) {
    try { await checked(`${fixture.admin}/v2/GetClusterHealth`, { headers: { authorization: `Bearer ${fixture.token}` } }); break; }
    catch (e) { if (i >= 90) throw e; await sleep(1000); }
  }
  const admin = async (path: string, body?: unknown) => (await checked(`${fixture.admin}/v2/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
  const key = await admin("CreateKey", { name: "performance", neverExpires: true }) as any;
  fixture.access = key.accessKeyId; fixture.secret = key.secretAccessKey;
  await pool(bucketCount, async (i) => {
    const bucket = await admin("CreateBucket", { globalAlias: `perf-bucket-${String(i).padStart(5, "0")}` }) as any;
    if (i === 0) fixture.bucketId = bucket.id;
  });
  await admin("AllowBucketKey", { bucketId: fixture.bucketId, accessKeyId: fixture.access, permissions: { read: true, write: true, owner: true } });
  save("fixture.json", fixture);
  await pool(objectCount, async (i) => {
    const url = new URL(`${fixture.s3}/perf-bucket-00000/perf/object-${String(i).padStart(6, "0")}.txt`);
    await (await checked(url.href, { method: "PUT", headers: sign("PUT", url, fixture.access, fixture.secret), body: "" })).arrayBuffer();
  });
  const buckets = await admin("ListBuckets") as any[];
  let objects = 0, token = "";
  do {
    const url = new URL(`${fixture.s3}/perf-bucket-00000?list-type=2&prefix=perf%2F&max-keys=1000`);
    if (token) url.searchParams.set("continuation-token", token);
    const xml = await (await checked(url.href, { headers: sign("GET", url, fixture.access, fixture.secret) })).text();
    objects += (xml.match(/<Contents>/g) ?? []).length;
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "";
  } while (token);
  if (buckets.length !== bucketCount || objects !== objectCount) throw new Error(`Wrong fixture counts: buckets=${buckets.length} objects=${objects}`);
  save("counts.json", { buckets: buckets.length, objects, prefix: "perf/", objectBytes: 0, seedTransientErrors, image: fixture.image, availableBytes: disk() });
  console.log(JSON.stringify({ buckets: buckets.length, objects, prefix: "perf/", seed: "pass" }));
} else {
  const fixture = JSON.parse(readFileSync(statePath, "utf8"));
  if (mode === "cleanup") {
    if (!/^garage-ui-perf-\d+-\d+$/.test(fixture.container) || fixture.volume !== fixture.container) throw new Error("Invalid cleanup identities");
    docker("rm", "-f", fixture.container);
    docker("volume", "rm", fixture.volume);
    save("cleanup.json", { container: fixture.container, volume: fixture.volume, cleaned: true });
    console.log("Temporary Garage container and volume removed");
  } else {
    if (!binary) throw new Error("measure requires a verified current binary");
    const counts = JSON.parse(readFileSync(join(work, "counts.json"), "utf8"));
    if (counts.buckets !== bucketCount || counts.objects !== objectCount) throw new Error("Full fixture required");
    const copied = join(work, "garage-ui"); copyFileSync(resolve(binary), copied);
    const binarySha256 = createHash("sha256").update(readFileSync(copied)).digest("hex");
    const garageLogStart = new Date().toISOString();
    const host = { load: execFileSync("uptime", { encoding: "utf8" }).trim(), cores: Number(execFileSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" })) };
    const appBase = "http://[::1]:3909", password = randomBytes(20).toString("hex");
    const server = spawn(copied, [], { env: { ...process.env, HOST: "::1", COOKIE_SECURE: "false", DATA_DIR: join(work, `ui-data-${Date.now()}`), GARAGE_ADMIN_URL: fixture.admin, GARAGE_ADMIN_TOKEN: fixture.token, S3_ENDPOINT_URL: fixture.s3, S3_REGION: "garage", S3_ACCESS_KEY_ID: fixture.access, S3_SECRET_ACCESS_KEY: fixture.secret }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = ""; server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
    let browser: any;
    try {
      for (let i = 0; ; i++) { try { await checked(`${appBase}/healthz`); break; } catch(e) { if (i > 60 || server.exitCode !== null) throw e; await sleep(1000); } }
      const { chromium } = await import("../web/node_modules/@playwright/test/index.mjs");
      browser = await chromium.launch({ headless: true });
      const bootstrap = await browser.newContext();
      const setup = await bootstrap.request.post(`${appBase}/api/setup`, { data: { username: "performance", password } });
      if (!setup.ok()) throw new Error(`Setup HTTP ${setup.status()}`);
      const csrf = (await bootstrap.cookies()).find((c: any) => c.name === "garage_csrf")!.value;
      const bind = await bootstrap.request.put(`${appBase}/api/buckets/${fixture.bucketId}/credential`, { headers: { "x-csrf-token": csrf }, data: { access_key_id: fixture.access } });
      if (!bind.ok()) throw new Error(`Credential HTTP ${bind.status()}`);
      const storageState = await bootstrap.storageState(); await bootstrap.close();
      const results: any[] = [];
      // Interleave lists; each navigation has an empty HTTP cache and no React query cache.
      for (let run = 1; run <= 3; run++) for (const list of ["buckets", "objects"]) {
        const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 } });
        const page = await context.newPage(); const requests: any[] = [], errors: string[] = [], assetResponses: any[] = [];
        page.on("request", (r: any) => { if (new URL(r.url()).pathname.startsWith("/api/")) requests.push({ method: r.method(), path: new URL(r.url()).pathname, query: new URL(r.url()).search }); });
        page.on("response", (r: any) => { if (new URL(r.url()).pathname.startsWith("/assets/")) assetResponses.push(r); if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
        page.on("pageerror", (e: Error) => errors.push(e.message));
        await page.goto(`${appBase}/#buckets${list === "objects" ? `/${fixture.bucketId}/perf/` : ""}`, { waitUntil: "commit" });
        const selector = list === "buckets" ? '[aria-label="Buckets"] tbody tr' : '[aria-label="Objects"] tbody tr';
        await page.waitForFunction((s: string) => {
          const rows = [...document.querySelectorAll(s)];
          const row = rows.find(r => r.querySelector('input[aria-label^="Select perf/object-"]') || r.querySelector('button[aria-label^="Objects for "]'));
          if (!row) return false;
          const bounds = row.getBoundingClientRect();
          if (bounds.width === 0 || bounds.height === 0 || bounds.top >= innerHeight) return false;
          (window as any).__firstRowMs ??= performance.now();
          return true;
        }, selector, { polling: "raf", timeout: 60_000 }).catch(async (error: Error) => {
          await page.screenshot({ path: join(work, `${list}-failure.png`), fullPage: true });
          save(`${list}-failure.json`, { requests, errors, text: await page.locator("body").innerText() });
          throw error;
        });
        const ms = await page.evaluate(() => (window as any).__firstRowMs);
        await page.waitForLoadState("networkidle");
        const perObject = requests.filter(r => /\/objects\/.+|\/inspect\/|\/thumbnail/.test(r.path));
        const listRequests = requests.filter(r => list === "objects" ? r.path === `/api/buckets/${fixture.bucketId}/objects` : r.path === "/api/buckets");
        const assets = await Promise.all(assetResponses.map(async r => ({ path: new URL(r.url()).pathname, sha256: createHash("sha256").update(await r.body()).digest("hex") })));
        const renderedRows = await page.locator(selector).count();
        const result = { list, run, ms, renderedRows, assets, errors, perObjectRequests: perObject.length, listRequests: listRequests.length, requests };
        results.push(result); console.log(JSON.stringify(result));
        await page.screenshot({ path: join(work, `${list}-${run}.png`) }); await context.close();
      }
      const max = Object.fromEntries(["buckets", "objects"].map(list => [list, Math.max(...results.filter(r => r.list === list).map(r => r.ms))]));
      const manifest = (r: any) => JSON.stringify([...r.assets].sort((a, b) => a.path.localeCompare(b.path)));
      const stableAssets = ["buckets", "objects"].every(list => results.filter(r => r.list === list).every(r => manifest(r) === manifest(results.find(r => r.list === list))));
      let pass = stableAssets && results.every(r => r.ms <= 2000 && r.errors.length === 0 && r.perObjectRequests === 0 && r.listRequests === 1);
      const receipt = spawnSync("docker", ["logs", "--since", garageLogStart, fixture.container], { encoding: "utf8" });
      if (receipt.status !== 0) throw new Error(`Garage log receipt failed: ${receipt.status}`);
      const logs = receipt.stdout + receipt.stderr;
      const upstreamRequests = logs.split("\n").filter(line => / (GET|HEAD) \/(?!v2\/)/.test(line)).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\(key [^)]+\)/g, "(key REDACTED)"));
      save("upstream-requests.json", upstreamRequests);
      const upstreamLists = upstreamRequests.filter(line => line.includes(`GET /${fixture.bucketId}/?`) && line.includes("list-type=2"));
      pass = pass && upstreamRequests.length === 3 && upstreamLists.length === 3;
      save("results.json", { pass, host, upstreamRequests, counts, binarySha256, appBase, runs: results, max, measurement: "navigation start to first visible list data row; fresh authenticated Chromium context per run" });
      console.log(JSON.stringify({ pass, max, binarySha256 }));
      if (!pass) throw new Error("First-screen performance acceptance failed; see results.json");
    } finally { if (browser) await browser.close(); server.kill("SIGTERM"); writeFileSync(join(work, "server.log"), serverLog); }
  }
}
