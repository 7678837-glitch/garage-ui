import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { garageTarget } from "./garage-target";

const evidenceBase = process.env.GARAGE_UI_E2E_EVIDENCE_DIR ?? fileURLToPath(new URL("../../evidence-local/e2e/", import.meta.url));
export const evidenceDir = join(evidenceBase, garageTarget().version);

const widths = [360, 390, 768, 1280] as const;

function ensureDir(): void {
  mkdirSync(evidenceDir, { recursive: true });
}

export async function assertRenderedLayout(page: Page, name: string): Promise<void> {
  const measured = await page.evaluate(async () => {
    const visible = (element: Element) => element.checkVisibility() && element.getClientRects().length > 0;
    // Portals animate their transform, so measure only after the visible finite animations settle.
    for (let attempt = 0; ; attempt += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const animations = document.getAnimations().filter((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return (animation.playState === "running" || animation.pending) && target instanceof Element && visible(target)
          && animation.effect?.getComputedTiming().endTime !== Infinity;
      });
      if (animations.length === 0) break;
      if (attempt === 3) throw new Error("Visible layout animations did not settle");
      await Promise.allSettled(animations.map((animation) => animation.finished));
    }
    const tables = Array.from(document.querySelectorAll("main table")).filter(visible).flatMap((table) => {
      const row = Array.from(table.querySelectorAll("tbody tr")).find(visible);
      if (!row) return [];
      const tableBox = table.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      let top = rowBox.top, bottom = rowBox.bottom, left = rowBox.left, right = rowBox.right;
      for (let ancestor = row.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      }
      return [{ label: table.closest("[aria-label]")?.getAttribute("aria-label"), height: tableBox.height,
        rowHeight: rowBox.height, overlaps: rowBox.bottom > tableBox.top && rowBox.top < tableBox.bottom,
        unclipped: bottom > top && right > left }];
    });
    const controls = innerWidth <= 639 ? Array.from(document.querySelectorAll("button:not([role=checkbox]):not([role=radio]),summary,[role=tab],input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),textarea,select"))
      .filter((element) => visible(element) && element.getAttribute("aria-hidden") !== "true")
      .map((element) => ({ label: element.getAttribute("aria-label") ?? element.textContent?.trim(),
        // Radix focuses the input when its wrapper padding is pressed; that wrapper is the hit target.
        height: (element.matches(".rt-TextFieldInput") ? element.closest(".rt-TextFieldRoot") ?? element : element).getBoundingClientRect().height, field: ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName), font: parseFloat(getComputedStyle(element).fontSize) })) : [];
    return { tables, controls };
  });
  for (const table of measured.tables) {
    expect.soft(table.height, `${name}: ${table.label} table visibly contains its records`).toBeGreaterThan(0);
    expect.soft(table.rowHeight, `${name}: ${table.label} record has visible height`).toBeGreaterThan(0);
    expect.soft(table.overlaps, `${name}: ${table.label} record intersects the table`).toBe(true);
    expect.soft(table.unclipped, `${name}: ${table.label} record is not clipped by its scroll container`).toBe(true);
  }
  for (const control of measured.controls) {
    expect.soft(control.height, `${name}: ${control.label} phone control height`).toBeGreaterThanOrEqual(36);
    if (control.field) expect.soft(control.font, `${name}: ${control.label} phone input font`).toBeGreaterThanOrEqual(16);
  }
}

export async function assertWidth(page: Page, name: string, width: number): Promise<void> {
  ensureDir();
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
  );
  await assertRenderedLayout(page, `${name} at ${width}`);
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  await page.screenshot({
    path: `${evidenceDir}/${name}-${width}.png`,
    fullPage: true,
  });
  await page.screenshot({ path: `${evidenceDir}/${name}-${width}-viewport.png`, fullPage: false });
  expect
    .soft(
      measured.scrollWidth,
      `${name} at ${width}: scrollWidth ${measured.scrollWidth}, innerWidth ${measured.innerWidth}`,
    )
    .toBeLessThanOrEqual(measured.innerWidth);
}

export async function recordLayout(page: Page, name: string): Promise<void> {
  const previous = page.viewportSize();
  for (const width of widths) {
    await assertWidth(page, name, width);
  }
  if (previous) {
    await page.setViewportSize(previous);
  }
}
