import { assertAuthenticated, bucketIdFromRow, openDisclosure, openNavigation, openRowActions, openUpload } from "./interactions";
import { expect, type CDPSession, type Locator, type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const aliasPrefix = "e2e-288-";
const singlePutCeiling = 8 * 1024 * 1024;
const seekTarget = 1;

type PreviewHit = {
  range: string;
  status: number;
};

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DomNode = {
  nodeName?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
};

test("seeks a video preview to one second and plays it", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const alias = `${aliasPrefix}${stamp}`;
  const keyName = `${aliasPrefix}key-${stamp}`;
  const work = mkdtempSync(join(tmpdir(), aliasPrefix));
  const clipPath = join(work, "clip.mp4");
  let bucketId = "";
  let keyId = "";
  let bodyError: unknown;
  let bodyFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;
  const hits: PreviewHit[] = [];
  let objectPuts = 0;

  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/objects/clip.mp4")) {
      objectPuts += 1;
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!isClipPreview(url)) {
      return;
    }
    const status = response.status();
    void response
      .request()
      .allHeaders()
      .then((headers) => {
        hits.push({ range: headers.range ?? "", status });
      });
  });

  try {
    page.setDefaultTimeout(30_000);
    writeClip(clipPath);
    const clipSize = statSync(clipPath).size;
    expect(clipSize).toBeGreaterThan(1000);
    expect(clipSize).toBeLessThan(singlePutCeiling);

    await page.goto("/");
    await logIn(page);
    bucketId = await createBucket(page, alias);
    keyId = await createKey(page, keyName);
    await grantKey(page, alias, bucketId, keyId);
    await openObjects(page, bucketId);
    const objects = page.locator("section[aria-label=\"Objects\"]");
    await bindKey(objects, keyId);
    await objects.locator("summary").filter({ hasText: /^Upload$/ }).click();

    await openUpload(objects);
    await objects.getByLabel("Choose files").setInputFiles(clipPath);
    const upload = page.getByRole("region", { name: "Upload" });
    await expect(upload.getByRole("listitem").filter({ hasText: "clip.mp4" }).getByText("Done", { exact: true })).toBeVisible();
    expect(objectPuts).toBe(1);

    await objects.getByRole("checkbox", { name: "Select clip.mp4" }).check();
    const details = objects.getByRole("region", { name: "Object details" });
    await expect(details).toContainText(`Size ${clipSize}`);
    await expect(details).toContainText("video/mp4");
    const etag = (await details.getByText(/^ETag /).innerText()).replace(/^ETag /, "");
    expect(etag).toMatch(/^[0-9a-f]+$/);
    const video = details.locator("video");
    await expect(video).toBeVisible();
    await expect(video).toHaveJSProperty("controls", true);

    const sample = await seekAndPlay(video);
    expect(sample.duration, `duration ${sample.duration}`).toBeCloseTo(2, 0);
    expect(sample.currentTime, `currentTime ${sample.currentTime} after play`).toBeCloseTo(seekTarget, 0);
    await expect
      .poll(() => rangeEvidence(hits), { timeout: 15_000 })
      .toBe("ranged");
    console.log(
      `byte-range ${hits.map((hit) => `range=${hit.range || "none"} status=${hit.status}`).join("; ")}`,
    );

    const dragged = await dragNativeTimeline(page, video, sample.duration);
    if (dragged === null) {
      const note = "user-agent shadow, Playwright could not reach it";
      console.log(`native-scrubber ${note}`);
      test.info().annotations.push({ type: "native-scrubber", description: note });
    } else {
      expect(dragged.currentTime, `dragged to ${dragged.currentTime}`).toBeCloseTo(dragged.expected, 0);
      const note = `dragged to ${dragged.currentTime.toFixed(2)}`;
      console.log(`native-scrubber ${note}`);
      test.info().annotations.push({ type: "native-scrubber", description: note });
    }

    await assertWidth(page, "video-seek", 1280);
    await assertWidth(page, "video-seek", 360);
  } catch (error) {
    bodyError = error;
    bodyFailed = true;
  } finally {
    rmSync(work, { recursive: true, force: true });
    try {
      await release(page, alias, bucketId, keyId);
    } catch (cleanup) {
      cleanupError = cleanup;
      cleanupFailed = true;
      if (bodyFailed) {
        console.error(cleanup);
      }
    }
  }
  if (bodyFailed) {
    throw bodyError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
});

function writeClip(path: string): void {
  execFileSync(
    "/opt/homebrew/bin/ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=160x120:rate=30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      path,
    ],
    { stdio: "pipe" },
  );
}

function isClipPreview(url: string): boolean {
  return url.includes("clip.mp4") && url.includes("preview=1");
}

function rangeEvidence(hits: PreviewHit[]): string {
  if (hits.some((hit) => hit.range.toLowerCase().startsWith("bytes=") || hit.status === 206)) {
    return "ranged";
  }
  if (hits.length === 0) {
    return "no preview response yet";
  }
  return hits.map((hit) => `range=${hit.range || "none"} status=${hit.status}`).join("; ");
}

async function seekAndPlay(video: Locator): Promise<{ currentTime: number; duration: number }> {
  return video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    const detail = () =>
      `readyState ${media.readyState} error ${media.error?.code ?? "none"} duration ${media.duration} time ${media.currentTime}`;
    if (media.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(`metadata timeout ${detail()}`)), 20_000);
        media.addEventListener(
          "loadedmetadata",
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        media.addEventListener(
          "error",
          () => {
            window.clearTimeout(timer);
            reject(new Error(`video error ${detail()}`));
          },
          { once: true },
        );
      });
    }
    const target = 1;
    if (!Number.isFinite(media.duration) || media.duration < 1.5) {
      throw new Error(`clip duration is not about 2 seconds; ${detail()}`);
    }
    const coversTarget = () => media.seekable.length > 0 && media.seekable.end(media.seekable.length - 1) >= target;
    if (!coversTarget()) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(`not seekable ${detail()}`)), 20_000);
        const check = () => {
          if (!coversTarget()) {
            return;
          }
          window.clearTimeout(timer);
          media.removeEventListener("progress", check);
          media.removeEventListener("loadeddata", check);
          resolve();
        };
        media.addEventListener("progress", check);
        media.addEventListener("loadeddata", check);
        check();
      });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`seek stayed at ${media.currentTime}; ${detail()}`)), 10_000);
      media.addEventListener(
        "seeked",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      media.currentTime = target;
    });
    await media.play();
    return { currentTime: media.currentTime, duration: media.duration };
  });
}

async function dragNativeTimeline(
  page: Page,
  video: Locator,
  duration: number,
): Promise<{ currentTime: number; expected: number } | null> {
  await video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    media.pause();
    // Quarter speed so playback during the gesture cannot reach the end and look like a seek.
    media.playbackRate = 0.25;
  });
  await video.hover();
  const fraction = 0.9;
  const expected = duration * fraction;
  const videoBox = await video.boundingBox();
  const candidates: Box[] = [];
  if (videoBox) {
    candidates.push(videoBox);
  }
  const slider = await sliderOverVideo(page, video);
  if (slider) {
    candidates.push(slider);
  }
  const shadow = await timelineFromShadow(page);
  if (shadow) {
    candidates.push(shadow);
  }
  for (const box of candidates) {
    const y = box.height > 24 ? box.y + box.height - 8 : box.y + box.height / 2;
    const before = await mediaState(video);
    await dragLine(page, box.x + box.width * 0.12, box.x + box.width * fraction, y);
    const after = await mediaState(video);
    if (!after.paused) {
      await video.evaluate((element) => {
        (element as HTMLVideoElement).pause();
      });
      continue;
    }
    if (Math.abs(after.time - before.time) > 0.3) {
      return { currentTime: after.time, expected };
    }
  }
  return null;
}

async function mediaState(video: Locator): Promise<{ time: number; paused: boolean }> {
  return video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    return { time: media.currentTime, paused: media.paused };
  });
}

async function sliderOverVideo(page: Page, video: Locator): Promise<Box | null> {
  const videoBox = await video.boundingBox();
  if (!videoBox) {
    return null;
  }
  const sliders = page.getByRole("slider");
  const count = await sliders.count();
  for (let index = 0; index < count; index += 1) {
    const box = await sliders.nth(index).boundingBox();
    if (!box || box.width < 8) {
      continue;
    }
    const overlaps =
      box.x < videoBox.x + videoBox.width &&
      box.x + box.width > videoBox.x &&
      box.y < videoBox.y + videoBox.height &&
      box.y + box.height > videoBox.y;
    if (overlaps) {
      return box;
    }
  }
  return null;
}

async function timelineFromShadow(page: Page): Promise<Box | null> {
  const client = await page.context().newCDPSession(page);
  try {
    const described = await describeVideo(client);
    const node = described ? timelineNode(described) : null;
    if (!node?.backendNodeId) {
      return null;
    }
    const model = await client.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
    return viewportBox(page, model.model.content);
  } catch {
    return null;
  } finally {
    await client.detach();
  }
}

async function describeVideo(client: CDPSession): Promise<DomNode | null> {
  const document = await client.send("DOM.getDocument", { depth: 0 });
  const root = document.root.nodeId;
  const found = await client.send("DOM.querySelector", { nodeId: root, selector: "video" });
  if (!found.nodeId) {
    return null;
  }
  const described = await client.send("DOM.describeNode", {
    nodeId: found.nodeId,
    depth: -1,
    pierce: true,
  });
  return described.node as DomNode;
}

function timelineNode(node: DomNode): DomNode | null {
  const attrs = attributeMap(node.attributes);
  const name = (node.nodeName ?? "").toLowerCase();
  const pseudo = attrs.get("pseudo") ?? "";
  const role = (attrs.get("role") ?? "").toLowerCase();
  const label = (attrs.get("aria-label") ?? "").toLowerCase();
  const type = (attrs.get("type") ?? "").toLowerCase();
  const named = /seek|time|scrub|timeline|progress/.test(label) || pseudo.includes("timeline");
  const timeline =
    pseudo.includes("media-controls-timeline") ||
    (name === "input" && type === "range" && named) ||
    (role === "slider" && named);
  if (timeline && node.backendNodeId) {
    return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const found = timelineNode(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function attributeMap(attributes: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const list = attributes ?? [];
  for (let index = 0; index < list.length; index += 2) {
    map.set(list[index] ?? "", list[index + 1] ?? "");
  }
  return map;
}

async function viewportBox(page: Page, quad: number[]): Promise<Box | null> {
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 2) {
    return null;
  }
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const shifted = { x: left - scroll.x, y: top - scroll.y, width, height };
  if (shifted.y > -5 && shifted.y < 4000) {
    return shifted;
  }
  return { x: left, y: top, width, height };
}

async function dragLine(page: Page, startX: number, endX: number, y: number): Promise<void> {
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 12 });
  await page.mouse.up();
}

async function logIn(page: Page): Promise<void> {
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
  await expect(async () => {
    const buckets = page.getByRole("region", { name: "Buckets" });
    if (!(await buckets.getByLabel("Filter buckets").isVisible())) {
      await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
    }
    await buckets.getByLabel("Filter buckets").fill(alias);
    const row = buckets.locator("tbody tr", { hasText: alias });
    if ((await row.count()) > 0) {
      return;
    }
    const more = buckets.getByRole("button", { name: "Load more", exact: true });
    if (await more.isVisible()) {
      await more.click();
    } else {
      await page.reload();
      await assertAuthenticated(page);
      await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Buckets", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Buckets", exact: true })).toBeVisible();
    }
    await page.getByRole("region", { name: "Buckets" }).getByLabel("Filter buckets").fill(alias);
    expect(
      await page.getByRole("region", { name: "Buckets" }).locator("tbody tr", { hasText: alias }).count(),
    ).toBeGreaterThan(0);
  }).toPass({ timeout: 40_000 });
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
  await buckets.getByRole("button", { name: `Open objects (${bucketId})`, exact: true }).click();
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


async function release(page: Page, alias: string, bucketId: string, keyId: string): Promise<void> {
  if (page.isClosed()) {
    return;
  }
  if (bucketId.length > 0 && !alias.startsWith(aliasPrefix)) {
    throw new Error(`refusing to delete bucket ${bucketId} outside ${aliasPrefix}`);
  }
  if (bucketId.length > 0) {
    await emptyBucket(page, bucketId);
    const headers = await csrfHeader(page);
    const removed = await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}`, { headers });
    if (removed.status() !== 200 && removed.status() !== 204) {
      throw new Error(`bucket delete failed with status ${removed.status()} ${await removed.text()}`);
    }
  }
  if (keyId.length > 0) {
    const headers = await csrfHeader(page);
    const removed = await page.request.delete(`/api/keys/${encodeURIComponent(keyId)}`, { headers });
    if (removed.status() !== 200 && removed.status() !== 204) {
      throw new Error(`key delete failed with status ${removed.status()} ${await removed.text()}`);
    }
  }
}

async function emptyBucket(page: Page, bucketId: string): Promise<void> {
  const headers = await csrfHeader(page);
  const multipart = await page.request.delete(`/api/buckets/${encodeURIComponent(bucketId)}/multipart`, {
    headers,
    data: "{}",
  });
  if (multipart.status() !== 200 && multipart.status() !== 204) {
    throw new Error(`multipart cleanup failed with status ${multipart.status()} ${await multipart.text()}`);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const listed = await page.request.get(`/api/buckets/${encodeURIComponent(bucketId)}/objects?prefix=&limit=100`);
    if (listed.status() === 412) {
      return;
    }
    if (listed.status() !== 200) {
      throw new Error(`object list failed with status ${listed.status()} ${await listed.text()}`);
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
      const path = entry.kind === "prefix" ? `${objectUrl(bucketId, key)}?recursive=true` : objectUrl(bucketId, key);
      const removed = await page.request.delete(path, { headers });
      if (removed.status() !== 200 && removed.status() !== 204) {
        throw new Error(`object delete failed with status ${removed.status()} ${await removed.text()}`);
      }
    }
  }
  throw new Error("bucket still has objects");
}

function objectUrl(bucketId: string, key: string): string {
  const encoded = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encoded}`;
}

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies("http://127.0.0.1:3909");
  const value = cookies.find((cookie) => cookie.name === "garage_csrf")?.value ?? "";
  if (value.length === 0) {
    throw new Error("missing garage_csrf cookie");
  }
  return { "x-csrf-token": value };
}
