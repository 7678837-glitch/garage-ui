import { assertRenderedLayout } from "./layout";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { administrator } from "./accounts";
import { assertAuthenticated, openNavigation, openDisclosure, selectChoice } from "./interactions";

const evidence = process.env.OPERATIONS_EVIDENCE ?? "/tmp/garage-ui-allpages-operations";
mkdirSync(evidence, { recursive: true });
const matrix: unknown[] = existsSync(`${evidence}/matrix.json`) ? JSON.parse(readFileSync(`${evidence}/matrix.json`, "utf8")) : [];
async function capture(page: Page, name: string, actions: string) {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Evidence requires a configured viewport");
  const width = viewport.width;
  const unique = name === "confirmation" ? `${name}-${test.info().title.replace(/[^a-zA-Z0-9]/g, "-")}-${matrix.length}` : name;
  const screenshot = `${evidence}/${unique}-${width}.png`;
  await assertRenderedLayout(page, `${name} at ${width}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const previousScroll = await page.evaluate(() => scrollY);
  await page.evaluate(() => scrollTo(0, 0));
  const screenshotTop = `${evidence}/${unique}-${width}-top.png`;
  await page.screenshot({ path: screenshotTop });
  await page.evaluate(y => scrollTo(0, y), previousScroll);
  const geometry = await page.evaluate(() => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }; };
    const visible = (element: Element) => element.checkVisibility();
    return {
      viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
      header: Array.from(document.querySelectorAll("header")).filter(visible).map(rect),
      headings: Array.from(document.querySelectorAll("h2,h3")).filter(visible).map(e => ({ text: e.textContent, ...rect(e) })),
      controls: Array.from(document.querySelectorAll("input,select,button,summary,[role=tab]")).filter(visible).map(e => ({ text: e.getAttribute("aria-label") ?? (e.closest("label")?.textContent ?? e.textContent)?.trim(), tag: e.tagName, type: e.getAttribute("type"), font: getComputedStyle(e).fontSize, ...rect(e) })),
      firstData: Array.from(document.querySelectorAll("main dt,main tbody tr")).filter(visible).slice(0, 1).map(rect),
    };
  });
  matrix.push({ page: name, viewport: width, actions, screenshot, screenshotTop, result: "operated", geometry });
  writeFileSync(`${evidence}/matrix.json`, JSON.stringify(matrix, null, 2));
  expect.soft(geometry.scrollWidth, `${name} document width`).toBeLessThanOrEqual(width);
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await assertAuthenticated(page);
}
async function navigate(page: Page, name: string) {
  await openNavigation(page);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
}
async function cancel(page: Page, name: string) {
  const dialog = page.getByRole("dialog", { name: `Confirm ${name}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox").fill(name);
  await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeEnabled();
  await capture(page, "confirmation", `Typed ${name.length}-character identity; enabled confirmation; cancelled`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function nodes(page: Page) {
  await navigate(page, "Nodes and layout");
  const region = page.getByRole("region", { name: "Cluster nodes", exact: true });
  await expect(region.getByLabel("Loading nodes")).toHaveCount(0);
  const link = region.locator('tbody a[href^="#node/"]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (href === null) throw new Error("Node link has no detail address");
  return { region, link, id: decodeURIComponent(href.split("/")[1]) };
}
for (const width of [360, 390, 768, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test.beforeEach(async ({ page }) => { await login(page); });
    test("Overview health, capacity and metrics", async ({ page }) => {
      await navigate(page, "Overview");
      const health = page.getByRole("region", { name: "Cluster health" });
      await expect(health.getByText("Healthy", { exact: true }).or(health.locator("dd").first())).toBeVisible();
      await expect(health.getByLabel("Loading cluster health")).toHaveCount(0);
      await capture(page, "overview-top", "Navigation to Overview; real health/capacity/activity loaded");
      const summaries = health.locator("summary").filter({ hasText: "Exact bytes" });
      for (let i = 0; i < await summaries.count(); i++) await openDisclosure(summaries.nth(i));
      await capture(page, "overview-exact-bytes", "Opened every exact-byte disclosure; scrolled through capacity and activity");
      for (let i = 0; i < await summaries.count(); i++) await summaries.nth(i).click();
      await page.reload();
      await expect(health).toBeVisible();
    });
    test("Nodes search, layout controls and all node tabs", async ({ page }) => {
      const mutations: string[] = [];
      page.on("request", r => { if (r.method() !== "GET" && /\/(layout|repair|blocks|snapshots)/.test(r.url()) && !r.url().endsWith("/api/layout/preview")) mutations.push(r.url().split("/api/")[1] ?? "mutation"); });
      const { region, link, id } = await nodes(page);
      await capture(page, "nodes-top", "Opened populated real node list");
      await region.getByLabel("Filter nodes").fill("allpages-no-such-node");
      await expect(region.locator('tbody a[href^="#node/"]')).toHaveCount(0);
      await region.getByLabel("Filter nodes").fill(id.slice(0, 10));
      await expect(link).toBeVisible();
      await selectChoice(region.getByLabel("Sort nodes"), "Hostname");
      await region.getByLabel("Filter nodes").fill("");
      await selectChoice(region.getByLabel("Sort nodes"), "Id");
      const maintenance = region.locator(":scope > details > summary", { hasText: "Maintenance" });
      await openDisclosure(maintenance);
      await expect(region.getByRole("button", { name: "Apply layout", exact: true })).toBeDisabled();
      await region.getByRole("button", { name: "Layout history", exact: true }).click();
      await expect(region.getByText("Current", { exact: true })).toBeVisible();
      await capture(page, "nodes-layout-history-connect", "Filtered absent/present nodes, changed sort, opened layout history and connect form; no shared layout writes");
      const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/layout/preview" && response.request().method() === "POST");
      await region.getByRole("button", { name: "Preview layout", exact: true }).click();
      const preview = await previewResponse;
      const previewBody = await preview.json() as { error?: string; message?: unknown; newLayout?: unknown };
      if (preview.ok() && typeof previewBody.error !== "string") {
        expect(previewBody.newLayout, "Native preview provides computed layout").toBeDefined();
        expect(Array.isArray(previewBody.message), "Native preview provides message lines").toBe(true);
        await expect(region.getByRole("button", { name: "Apply layout", exact: true })).toBeEnabled();
      } else {
        const message = typeof previewBody.error === "string" ? previewBody.error : typeof previewBody.message === "string" ? previewBody.message : "Layout preview failed";
        await expect.soft(region.getByText(message, { exact: true }), "Native preview failure remains visible").toBeVisible();
        await expect.soft(region.getByRole("button", { name: "Apply layout", exact: true }), "Failed computation cannot enable apply").toBeDisabled();
      }
      await capture(page, "nodes-layout-preview", `Actually clicked safe native preview POST; HTTP ${preview.status()}; native computation error ${typeof previewBody.error === "string" ? previewBody.error : "none"}; no apply submitted`);
      await region.getByRole("button", { name: "Skip dead nodes", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await capture(page, "nodes-skip-confirm", "Opened skip-dead-node risk confirmation and cancelled");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(region.getByRole("button", { name: "Connect node", exact: true })).toBeDisabled();
      await region.getByLabel("Node address", { exact: true }).fill("allpages-invalid-address");
      await expect(region.getByRole("button", { name: "Connect node", exact: true })).toBeEnabled();
      await region.getByLabel("Node address", { exact: true }).fill("");
      await maintenance.click();
      const rowMaintenance = region.locator("tbody tr").first().locator("summary").filter({ hasText: /^Maintenance$/ });
      await openDisclosure(rowMaintenance);
      await capture(page, "nodes-row-maintenance", "Opened populated node row maintenance and its capacity/block-hash forms without mutation");
      await rowMaintenance.click();
      await link.click();
      await expect(page.getByRole("tab", { name: "Information", exact: true })).toHaveAttribute("aria-selected", "true");
      const fullId = page.locator("summary").filter({ hasText: /Full ID/i });
      if (await fullId.count()) await openDisclosure(fullId.first());
      await capture(page, "node-information", "Opened Information tab and full long node ID");
      await page.getByRole("tab", { name: "Statistics", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Statistics", exact: true })).toHaveAttribute("aria-selected", "true");
      await capture(page, "node-statistics", "Selected Statistics tab; capacity rendered");
      await page.getByRole("tab", { name: "Maintenance", exact: true }).click();
      const capacity = page.getByRole("form", { name: "Node capacity" });
      await selectChoice(capacity.getByRole("combobox", { name: "Unit", exact: true }), "B");
      await capacity.getByLabel("Capacity", { exact: true }).fill("0.5");
      await capacity.getByRole("button", { name: "Save", exact: true }).click();
      await expect(capacity.getByRole("alert")).toHaveText("Enter a whole number of bytes");
      await capture(page, "node-maintenance-validation", "Changed unit and submitted fractional-byte capacity; validation prevented staging");
      await page.getByLabel(`Block hash for ${id}`, { exact: true }).fill("a".repeat(64));
      await page.getByRole("button", { name: `Purge blocks on ${id}`, exact: true }).click();
      await cancel(page, "a".repeat(64));
      await expect(page.getByRole("tab", { name: "Maintenance", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(mutations).toEqual([]);
    });
    test("Workers selection, filters, inspector and maintenance confirmations", async ({ page }) => {
      const mutations: string[] = [];
      page.on("request", r => { if (r.method() !== "GET" && /\/(repair|worker-variables)/.test(r.url())) mutations.push(r.method()); });
      await navigate(page, "Workers");
      const picker = page.getByRole("region", { name: "Select node", exact: true });
      await expect(picker.getByRole("link").first()).toBeVisible();
      await capture(page, "workers-picker", "Opened real node picker");
      await picker.getByRole("link", { name: "All nodes", exact: true }).click();
      const workers = page.getByRole("region", { name: "Workers", exact: true });
      const detail = workers.getByRole("button", { name: /^Details \d+: / }).first();
      await expect(detail).toBeVisible();
      await capture(page, "workers-all-top", "Selected All nodes; real worker rows loaded");
      await workers.getByLabel("Busy only", { exact: true }).check();
      await expect(workers.getByLabel("Busy only", { exact: true })).toBeChecked();
      await workers.getByLabel("Errors only", { exact: true }).check();
      await expect(workers.getByLabel("Errors only", { exact: true })).toBeChecked();
      await expect(workers.getByLabel("Loading workers")).toHaveCount(0);
      await capture(page, "workers-filtered", "Enabled both busy/error filters and observed actual filtered response");
      await workers.getByLabel("Busy only", { exact: true }).uncheck();
      await workers.getByLabel("Errors only", { exact: true }).uncheck();
      await detail.click();
      await expect(workers.getByRole("region", { name: /^Details \d+: / })).toBeVisible();
      await capture(page, "workers-details", "Toggled busy/errors filters, restored list and opened actual worker details");
      await navigate(page, "Workers");
      await picker.getByRole("link").filter({ hasNotText: "All nodes" }).first().click();
      await expect(workers).toBeVisible();
      await capture(page, "workers-single-top", "Selected one actual node; long node ID shown above the list");
      const id = new URL(page.url()).hash.split("/")[1];
      await openDisclosure(workers.locator(":scope > details > summary", { hasText: "Maintenance" }));
      const repairLauncher = workers.getByRole("button", { name: "Start repair", exact: true });
      const variableLauncher = workers.getByRole("button", { name: "Save variable", exact: true });
      await expect(repairLauncher).toBeVisible();
      await expect(variableLauncher).toBeVisible();
      const repairBox = await repairLauncher.boundingBox();
      const variableBox = await variableLauncher.boundingBox();
      if (repairBox === null || variableBox === null) throw new Error("Maintenance launchers require visible bounds");
      expect(
        repairBox.x + repairBox.width <= variableBox.x ||
        variableBox.x + variableBox.width <= repairBox.x ||
        repairBox.y + repairBox.height <= variableBox.y ||
        variableBox.y + variableBox.height <= repairBox.y,
        "Maintenance launchers do not overlap",
      ).toBe(true);
      await repairLauncher.click();
      const repair = page.getByRole("dialog", { name: "Start repair", exact: true });
      await expect(repair).toBeVisible();
      await selectChoice(repair.getByRole("combobox", { name: "Repair type", exact: true }), "scrub pause");
      await capture(page, "workers-repair-form", "Selected one node, opened Maintenance and scrub pause repair type");
      await repair.getByRole("button", { name: "Start repair", exact: true }).click();
      await cancel(page, decodeURIComponent(id));
      await expect(repair.getByRole("combobox", { name: "Repair type", exact: true })).toContainText("scrub pause");
      await repair.getByRole("button", { name: "Cancel", exact: true }).click();
      await variableLauncher.click();
      const variable = page.getByRole("dialog", { name: "Variable", exact: true });
      await expect(variable).toBeVisible();
      await expect(variable.getByRole("button", { name: "Save variable", exact: true })).toBeDisabled();
      await variable.getByLabel("Variable", { exact: true }).fill("allpages-inspect-only");
      await variable.getByLabel("Value", { exact: true }).fill("1");
      await capture(page, "workers-variable-form", "Expanded worker variable form and filled test-only proposal");
      await variable.getByRole("button", { name: "Save variable", exact: true }).click();
      await cancel(page, "allpages-inspect-only");
      await expect(variable.getByLabel("Variable", { exact: true })).toHaveValue("allpages-inspect-only");
      await expect(variable.getByLabel("Value", { exact: true })).toHaveValue("1");
      await variable.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(mutations).toEqual([]);
    });
    test("Block errors node selection and native empty state", async ({ page }) => {
      const mutations: string[] = [];
      page.on("request", r => { if (r.method() !== "GET" && /\/blocks\/(purge|retry)/.test(r.url())) mutations.push(r.method()); });
      await navigate(page, "Block errors");
      const picker = page.getByRole("region", { name: "Select node", exact: true });
      await expect(picker.getByRole("link").first()).toBeVisible();
      await capture(page, "block-errors-picker", "Opened real node picker");
      await picker.getByRole("link").first().click();
      const errors = page.getByRole("region", { name: "Block errors", exact: true });
      await expect(errors.getByLabel("Loading block errors")).toHaveCount(0);
      await expect(errors.getByText("There are no block errors.", { exact: true }).or(errors.locator("tbody tr").first())).toBeVisible();
      const rows = await errors.locator("tbody tr").count();
      await capture(page, "block-errors-selected", rows ? "Selected actual node with real error records" : "Selected actual node; native empty state; retry/purge/info controls absent");
      await page.reload();
      await expect(errors).toBeVisible();
      expect(mutations).toEqual([]);
    });
  });
}
