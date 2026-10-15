import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { administrator } from "./accounts";
import { assertAuthenticated, openNavigation } from "./interactions";
import { assertWidth } from "./layout";
import { submitLogin } from "./login";

for (const width of [360, 1280]) {
  test(`audit filters stay compact and export the active selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.getByLabel("Username", { exact: true }).fill(administrator.username);
    await page.getByLabel("Password", { exact: true }).fill(administrator.password);
    await submitLogin(page);
    await assertAuthenticated(page);
    await openNavigation(page);
    await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Audit", exact: true }).click();
    const audit = page.getByRole("region", { name: "Audit", exact: true });
    const disclosure = audit.locator("details.ui-audit-filters");
    const summary = disclosure.locator(":scope > summary");
    const exportButton = audit.getByRole("button", { name: "Export audit", exact: true });
    await expect(summary).toHaveText("Filters");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(audit.getByLabel("From", { exact: true })).not.toBeVisible();
    await expect(exportButton).toBeVisible();
    await expect(audit.getByRole("cell", { name: administrator.username, exact: true }).first()).toBeVisible();
    await assertWidth(page, "audit-filters-collapsed", width);
    await summary.focus();
    await summary.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    const user = audit.getByLabel("User", { exact: true });
    const from = audit.getByLabel("From", { exact: true });
    const to = audit.getByLabel("To", { exact: true });
    const target = audit.getByLabel("Target", { exact: true });
    await expect(target).toHaveAttribute("aria-describedby", "audit-target-hint");
    await expect(audit.locator("#audit-target-hint")).toBeVisible();
    await user.fill(administrator.username);
    await from.fill("2020-01-01T00:00");
    await to.fill("2030-01-01T00:00");
    for (const date of [from, to]) {
      await expect(date).toHaveAttribute("type", "datetime-local");
      const box = await date.boundingBox();
      if (!box) throw new Error("Audit date filter must have a visible bounding box");
      expect(box.width).toBeGreaterThanOrEqual(width === 360 ? 260 : 220);
    }
    if (width === 360) {
      const fromBox = await from.boundingBox();
      const toBox = await to.boundingBox();
      if (!fromBox || !toBox) throw new Error("Audit date filters must have visible bounding boxes");
      expect(Math.abs(fromBox.x - toBox.x)).toBeLessThan(1);
      expect(toBox.y).toBeGreaterThan(fromBox.y + fromBox.height);
    }
    await target.fill("no-such-audit-filters-target");
    await expect(summary).toHaveText("Filters (4)");
    await expect(audit.getByText("There are no audit events.", { exact: true })).toBeVisible();
    await assertWidth(page, "audit-filters-open", width);
    await summary.click();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(summary).toHaveText("Filters (4)");
    await summary.click();
    await expect(target).toHaveValue("no-such-audit-filters-target");
    await target.fill("");
    await expect(audit.getByRole("cell", { name: administrator.username, exact: true }).first()).toBeVisible();
    await summary.click();
    const preflight = page.waitForResponse((response) => response.request().method() === "HEAD" && new URL(response.url()).pathname === "/api/audit/export");
    const downloaded = page.waitForEvent("download");
    await exportButton.click();
    expect((await preflight).ok()).toBe(true);
    const download = await downloaded;
    const exportUrl = new URL(download.url());
    expect(exportUrl.pathname).toBe("/api/audit/export");
    expect(exportUrl.searchParams.get("user")).toBe(administrator.username);
    expect(exportUrl.searchParams.get("from")).toBe("1577836800");
    expect(exportUrl.searchParams.get("to")).toBe("1893456000");
    expect(exportUrl.searchParams.has("action")).toBe(false);
    expect(download.suggestedFilename()).toBe("audit.csv");
    const saved = testInfo.outputPath("audit.csv");
    await download.saveAs(saved);
    expect(await readFile(saved, "utf8")).toContain(administrator.username);
    await summary.click();
    await user.fill("");
    await from.fill("");
    await to.fill("");
    await expect(summary).toHaveText("Filters");
    await summary.click();
    await expect(exportButton).toBeVisible();
    await assertWidth(page, "audit-filters-cleared", width);
  });
}
