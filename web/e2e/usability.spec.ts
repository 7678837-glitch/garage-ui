import { submitLogin } from "./login";
import { expect, test, request as requestContextFactory, type Locator, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { administrator } from "./accounts";
import { assertWidth, assertRenderedLayout, evidenceDir } from "./layout";
import { garageTarget } from "./garage-target";
import { chooseTheme, openDisclosure, openNavigation, assertAuthenticated, openAccount, selectChoice } from "./interactions";

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

async function fitsViewport(page: Page, control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("Action or viewport has no bounding box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const scrollPositions = await control.evaluate((element) => {
    const positions: number[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) positions.push(current.scrollLeft);
    return positions;
  });
  expect(scrollPositions.every((position) => position === 0), "action needs no horizontal scrolling").toBe(true);
}

async function accessible(page: Page, label: string): Promise<void> {
  await page.evaluate(readFileSync(axePath, "utf8"));
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run(): Promise<{ violations: { impact: string }[] }> } }).axe;
    return (await axe.run()).violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical");
  });
  writeFileSync(`${evidenceDir}/${label}-axe.json`, JSON.stringify(violations, null, 2));
  expect(violations).toEqual([]);
}

async function headerLayout(page: Page, label: string): Promise<void> {
  const header = page.getByRole("banner");
  const menu = header.getByRole("button", { name: /^(Menu|菜单)$/ });
  const context = header.locator(".console-mobile-brand");
  const summary = header.locator(".console-account-trigger");
  const account = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^(Log out|退出)$/ }) });
  await expect(header.getByRole("navigation", { name: /^(Breadcrumb|路径)$/ })).toHaveCount(0);
  await expect(context).toBeVisible();
  if (new URL(page.url()).hash.startsWith("#key/")) {
    const back = context.getByRole("link");
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "#keys");
    await expect(back).toHaveText(/^← /);
  } else {
    await expect(context.locator('img[src$="/brand/garage-ui.svg"]')).toBeVisible();
    await expect(context).toHaveText("Garage UI");
  }
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(header.getByRole("status")).toHaveCount(0);
  expect(await summary.innerText()).not.toMatch(/Garage|Health|admin|ok ·/);
  const boxes = await Promise.all([menu, context, summary].map((item) => item.boundingBox()));
  const [menuBox, contextBox, accountBox] = boxes;
  if (!menuBox || !contextBox || !accountBox) throw new Error("Mobile header boxes missing");
  expect(menuBox.height).toBeGreaterThanOrEqual(36);
  expect(accountBox.height).toBeGreaterThanOrEqual(36);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(contextBox.x);
  expect(contextBox.x + contextBox.width).toBeLessThanOrEqual(accountBox.x);
  const center = menuBox.y + menuBox.height / 2;
  for (const box of [menuBox, contextBox, accountBox]) {
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(Math.abs(box.y + box.height / 2 - center)).toBeLessThanOrEqual(4);
  }
  expect(Math.abs(menuBox.y - accountBox.y)).toBeLessThanOrEqual(4);
  const headerBox = await header.boundingBox();
  if (!headerBox) throw new Error("Mobile header has no bounding box");
  expect(headerBox.height).toBeLessThanOrEqual(60);
  writeFileSync(`${evidenceDir}/${label}-header.json`, JSON.stringify({ boxes, summaryText: await summary.innerText(), accessibleName: await summary.getAttribute("aria-label") }, null, 2));
  await page.screenshot({ path: `${evidenceDir}/${label}-viewport.png`, fullPage: false });
  await openAccount(page);
  await expect(account.getByRole("status")).toBeVisible();
  await expect(account).toContainText(garageTarget().version);
  await page.screenshot({ path: `${evidenceDir}/${label}-account-open.png`, fullPage: false });
  await summary.click();
  await menu.focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: /^(Close navigation|关闭导航)$/ });
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await expect(close).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("dialog", { name: /^(Sections|分区)$/ })).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await openAccount(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: /^(Sections|分区)$/ })).toHaveCount(0);
}

for (const width of [360, 1280]) for (const theme of ["Light", "Dark"] as const) {
  test(`key settings and live worker usability ${width} ${theme}`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.locator('img[src$="/brand/garage-ui.svg"]')).toBeVisible();
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /garage-ui\.svg/);
    await page.getByLabel("Username").fill(administrator.username);
    await page.getByLabel("Password").fill(administrator.password);
    await submitLogin(page);
    await assertAuthenticated(page);
    await chooseTheme(page, theme);
    mkdirSync(evidenceDir, { recursive: true });
    await openNavigation(page);
    const navigation = page.getByRole("navigation", { name: "Sections" });
    for (const group of ["Storage", "Cluster", "Administration"]) await expect(navigation.getByText(group, { exact: true })).toBeVisible();
    await expect(navigation.locator('img[src$="/brand/garage-ui.svg"]')).toBeVisible();
    if (width < 900) {
      await expect(page.getByRole("dialog", { name: "Sections", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const headers = { "x-csrf-token": (await page.context().cookies()).find((cookie) => cookie.name === "garage_csrf")?.value ?? "" };
    const cleanup = await requestContextFactory.newContext({ baseURL: "http://127.0.0.1:3909", storageState: await page.context().storageState(), timeout: 10_000 });
    const name = `Usability-key-with-a-long-readable-name-${Date.now().toString(36)}-${width}-${theme}`;
    const response = await page.request.post("/api/keys", { headers, data: { name } });
    expect(response.ok(), `key fixture creation failed (${response.status()}): ${response.ok() ? "" : await response.text()}`).toBe(true);
    const created = await response.json() as { accessKeyId?: string; id?: string };
    const id = created.accessKeyId ?? created.id ?? "";
    expect(id).not.toBe("");
    writeFileSync(`${evidenceDir}/usability-fixture-${width}-${theme}.json`, JSON.stringify({ keyId: id, name }, null, 2));
    let userId: number | null = null;
    try {
      await page.goto(`/#key/${id}/settings`);
      await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute("aria-selected", "true");
      const panel = page.getByRole("tabpanel");
      const edit = panel.getByRole("button", { name: `Actions (${id})`, exact: true });
      const editor = page.getByRole("dialog", { name: "Name", exact: true });
      const input = editor.getByRole("textbox", { name: /^Name/ });
      const save = editor.getByRole("button", { name: /^Save name/ });
      await expect(edit).toBeVisible();
      await expect(edit).toHaveText("Actions");
      await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(1);
      for (const section of ["General", "Permissions", "Credentials", "Danger zone"]) await expect(panel.getByRole("heading", { name: section, exact: true })).toBeVisible();
      const permission = panel.getByRole("checkbox", { name: /^Allow bucket creation/ });
      await expect(permission).toBeVisible();
      await expect(permission.locator("..")).toHaveText("Allow bucket creation");
      await expect(permission).toHaveAccessibleName(/Allow bucket creation/);
      const identity = page.getByRole("main").locator("details").filter({ hasText: id });
      await expect(identity).toHaveCount(1);
      await expect(identity).not.toHaveAttribute("open", "");
      const exposedIds = await page.getByRole("main").evaluate((main, fullId) => {
        const found: string[] = [];
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (node.textContent?.includes(fullId) && parent && !parent.closest("details") && parent.getClientRects().length > 0) found.push(node.textContent);
        }
        return found;
      }, id);
      expect(exposedIds, "full identity belongs in its explicit disclosure").toEqual([]);
      await openDisclosure(identity.locator("summary"));
      await expect(identity.getByText(id, { exact: true })).toBeVisible();
      await identity.locator("summary").click();
      await edit.click();
      await expect(input).toHaveValue(name);
      await expect(input.locator("xpath=ancestor::label")).toBeVisible();
      await expect(input.locator("xpath=ancestor::label")).toHaveText("Name");
      await expect(save).toBeVisible();
      await expect(save).toHaveText("Save name");
      for (const [control, caption] of [[input, "Name"], [save, "Save name"]] as const) await expect(control).toHaveAccessibleName(new RegExp(caption));
      await assertRenderedLayout(page, `key name dialog ${width} ${theme}`);
      await expect(input.locator("..")).toHaveClass(/rt-TextFieldRoot/);
      const field = await input.locator("..").boundingBox();
      if (width === 360) expect(await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      if (!field) throw new Error("Name field has no bounding box");
      expect(field.width, "name field stays readable").toBeGreaterThanOrEqual(width === 360 ? 280 : 300);
      if (width === 360) {
        const button = await save.boundingBox();
        if (!button) throw new Error("Save name has no bounding box");
        expect(button.y).toBeGreaterThanOrEqual(field.y + field.height);
      }
      await assertWidth(page, `usability-key-settings-${theme.toLowerCase()}`, width);
      await accessible(page, `usability-key-${width}-${theme.toLowerCase()}`);
      await page.screenshot({ path: `${evidenceDir}/usability-key-settings-${theme.toLowerCase()}-${width}-viewport.png`, fullPage: false });
      await editor.getByRole("button", { name: "Close", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(edit).toBeFocused();
      if (width === 360) await headerLayout(page, `usability-key-${theme.toLowerCase()}-360`);
      await edit.click();
      await expect(input).toHaveValue(name);
      const draft = `${name} unsaved`;
      await input.fill(draft);
      for (const resize of [360, 390, 768, 1280, width]) {
        await assertWidth(page, `usability-key-dirty-${theme.toLowerCase()}`, resize);
        await expect(input).toHaveValue(draft);
        await editor.getByRole("button", { name: "Close", exact: true }).click();
        await expect(editor).toHaveCount(0);
        await expect(edit).toBeFocused();
        await openNavigation(page);
        const departure = page.waitForEvent("dialog");
        const leave = navigation.getByRole("link", { name: "Overview", exact: true }).click();
        const prompt = await departure;
        expect(prompt.type()).toBe("confirm");
        await prompt.dismiss();
        await leave;
        const close = page.getByRole("button", { name: "Close navigation", exact: true });
        if (resize < 900) await expect(close).toBeVisible();
        if (await close.isVisible()) await close.click();
        await expect(page.getByRole("dialog", { name: "Sections", exact: true })).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).hash).toBe(`#key/${id}/settings`);
        await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute("aria-selected", "true");
        await edit.click();
        await expect(input).toHaveValue(draft);
      }
      await input.fill(name);
      await editor.getByRole("button", { name: "Close", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const secret = panel.getByRole("button", { name: /^View secret/ });
      await expect(secret).toBeVisible();
      await secret.click();
      const secretDialog = page.getByRole("dialog");
      await expect(secretDialog.getByLabel("Secret access key", { exact: true })).toHaveAttribute("type", "password");
      await expect(secretDialog.getByRole("button", { name: "Copy secret", exact: true })).toBeVisible();
      await secretDialog.getByRole("button", { name: "I have saved it", exact: true }).click();
      await expect(secretDialog).toHaveCount(0);
      const danger = panel.getByRole("button", { name: /^Delete key/ });
      await expect(danger).toBeVisible();
      const deleteRequests: string[] = [];
      page.on("request", (request) => { if (request.method() === "DELETE") deleteRequests.push(new URL(request.url()).pathname); });
      await danger.click();
      const confirmation = page.getByRole("dialog");
      await expect(confirmation).toContainText(id);
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(deleteRequests).toEqual([]);
      await openNavigation(page);
      await navigation.getByRole("link", { name: "Workers", exact: true }).click();
      const picker = page.getByRole("region", { name: "Select node", exact: true });
      await picker.getByRole("link").filter({ hasNotText: "All nodes" }).first().click();
      await expect(page.getByLabel("Loading workers", { exact: true })).toHaveCount(0);
      const workers = page.getByRole("region", { name: "Workers", exact: true });
      const table = workers.getByRole("table").first();
      await expect(table).toBeVisible();
      for (const heading of ["Name", "State", "Errors", "Progress", "Details"]) await expect(table.getByRole("columnheader", { name: heading, exact: true })).toHaveCount(1);
      const row = table.locator("tbody tr").first();
      const collapsed = await row.boundingBox();
      writeFileSync(`${evidenceDir}/usability-workers-density-${width}-${theme.toLowerCase()}.json`, JSON.stringify({ box: collapsed, documentHeight: await page.evaluate(() => document.documentElement.scrollHeight), rowCount: await table.locator("tbody tr").count() }, null, 2));
      const details = row.getByRole("button", { name: /^Details/ });
      await expect(row).toBeVisible();
      const caption = (await details.innerText()).trim();
      await expect(details).toHaveAccessibleName(new RegExp(caption));
      const maintenance = workers.locator("summary", { hasText: "Maintenance" });
      await expect(maintenance).toBeVisible();
      expect(await maintenance.evaluate((element) => Boolean(element.compareDocumentPosition(element.closest("section")?.querySelector("table") ?? element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      await assertWidth(page, `usability-workers-${theme.toLowerCase()}`, width);
      await page.screenshot({ path: `${evidenceDir}/usability-workers-${theme.toLowerCase()}-${width}-viewport.png`, fullPage: false });
      // A vertical wheel moves the row into view without moving horizontally or relying on click auto-scroll.
      const actionBox = await details.boundingBox();
      if (actionBox && actionBox.y + actionBox.height > 800) await page.mouse.wheel(0, actionBox.y - 300);
      await expect.poll(async () => {
        const box = await details.boundingBox();
        return Boolean(box && box.y >= 0 && box.y + box.height <= 800);
      }).toBe(true);
      await fitsViewport(page, details);
      writeFileSync(`${evidenceDir}/usability-workers-action-${width}-${theme.toLowerCase()}.json`, JSON.stringify({ box: await details.boundingBox(), viewport: page.viewportSize(), scrollLeft: await row.evaluate((element) => element.scrollLeft), accessibleName: await details.getAttribute("aria-label") }, null, 2));
      const detailResponse = page.waitForResponse((result) => /\/workers\/\d+$/.test(new URL(result.url()).pathname));
      await details.click();
      const result = await detailResponse;
      const responseBody = await result.json() as { lastError?: { message?: string } };
      writeFileSync(`${evidenceDir}/usability-workers-response-${width}-${theme.toLowerCase()}.json`, JSON.stringify({ status: result.status(), body: responseBody }, null, 2));
      expect(result.status()).toBeLessThan(500);
      const diagnostic = row.getByRole("region", { name: new RegExp(caption) });
      await expect(diagnostic).toBeVisible();
      await expect(diagnostic).toBeFocused();
      await expect(diagnostic.getByRole("status").filter({ hasText: /^(Loading|Refreshing) worker details$/ })).toHaveCount(0, { timeout: 20_000 });
      if (result.ok()) {
        if (responseBody.lastError?.message) await expect(diagnostic).toContainText(responseBody.lastError.message);
        else {
          await expect(diagnostic.getByRole("alert"), "a valid worker with no lastError needs normal diagnostic feedback").toHaveCount(0);
          await expect(diagnostic).toContainText("No error reported");
          await expect(diagnostic).not.toContainText("Workers are unavailable");
          expect((await diagnostic.innerText()).trim().length, "diagnostic result must add information beyond its label").toBeGreaterThan((await diagnostic.getAttribute("aria-label"))?.length ?? 0);
        }
      } else await expect(diagnostic.getByRole("alert")).toBeVisible();
      writeFileSync(`${evidenceDir}/usability-workers-result-${width}-${theme.toLowerCase()}.json`, JSON.stringify({ status: result.status(), text: await diagnostic.innerText(), box: await diagnostic.boundingBox() }, null, 2));
      await assertWidth(page, `usability-workers-detail-${theme.toLowerCase()}`, width);
      await accessible(page, `usability-workers-${width}-${theme.toLowerCase()}`);
      await page.screenshot({ path: `${evidenceDir}/usability-workers-detail-${theme.toLowerCase()}-${width}-viewport.png`, fullPage: false });
      if (width === 360) {
        const username = `e2e-ux-${Date.now().toString(36)}-${theme}-`.padEnd(63, "x");
        const password = "e2e-long-account-password";
        const createdUser = await page.request.post("/api/users", { headers, data: { username, password, role: "admin" } });
        expect(createdUser.status()).toBe(201);
        userId = (await createdUser.json() as { id: number }).id;
        writeFileSync(`${evidenceDir}/usability-user-fixture-${theme.toLowerCase()}.json`, JSON.stringify({ userId, username }, null, 2));
        const context = await browser.newContext({ baseURL: "http://127.0.0.1:3909", viewport: { width: 360, height: 800 } });
        let translated: Page | null = null;
        try {
          translated = await context.newPage();
          translated.setDefaultTimeout(10_000);
          await translated.goto("/");
          await translated.getByLabel("Username").fill(username);
          await translated.getByLabel("Password").fill(password);
          await submitLogin(translated);
          await assertAuthenticated(translated);
          await chooseTheme(translated, theme);
          await openNavigation(translated);
          await translated.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Settings", exact: true }).click();
          await selectChoice(translated.getByLabel("Language"), "Chinese");
          await expect(translated.getByLabel("语言")).toBeVisible();
          await translated.goto(page.url());
          await expect(translated.getByRole("region", { name: "工作线程", exact: true }).getByRole("table")).toBeVisible();
          await headerLayout(translated, `usability-long-username-zh-${theme.toLowerCase()}-360`);
          await accessible(translated, `usability-long-username-zh-${theme.toLowerCase()}`);
          await assertWidth(translated, `usability-long-username-zh-${theme.toLowerCase()}`, 360);
          await translated.getByRole("button", { name: /详情/ }).first().click();
          await expect(translated.getByRole("region", { name: /详情/ })).toContainText("未报告错误");
        } catch (error) {
          if (translated && !translated.isClosed()) await translated.screenshot({ path: `${evidenceDir}/usability-long-account-failure-${theme.toLowerCase()}.png`, fullPage: false });
          writeFileSync(`${evidenceDir}/usability-long-account-failure-${theme.toLowerCase()}.txt`, String(error).replaceAll(password, "[redacted]"));
          throw error;
        } finally { await context.close(); }
      }
    } finally {
      try {
        if (userId !== null) {
          const removedUser = await cleanup.delete(`/api/users/${userId}`, { headers });
          expect(removedUser.status(), `exact user fixture cleanup ${userId}`).toBe(204);
          console.log(`Usability user fixture cleanup ${userId}: ${removedUser.status()}`);
        }
      } finally {
        try {
          const removed = await cleanup.delete(`/api/keys/${encodeURIComponent(id)}`, { headers });
          expect(removed.status(), `exact key fixture cleanup ${id}`).toBe(200);
          console.log(`Usability fixture cleanup ${id}: ${removed.status()}`);
        } finally { await cleanup.dispose(); }
      }
    }
  });
}
