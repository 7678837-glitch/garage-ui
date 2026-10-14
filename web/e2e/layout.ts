import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { garageTarget } from "./garage-target";

export const evidenceDir = fileURLToPath(
  new URL(`../../evidence/e2e/${garageTarget().version}/`, import.meta.url),
);

const widths = [1280, 360] as const;

function ensureDir(): void {
  mkdirSync(evidenceDir, { recursive: true });
}

export async function assertWidth(page: Page, name: string, width: number): Promise<void> {
  ensureDir();
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
  );
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  await page.screenshot({
    path: `${evidenceDir}/${name}-${width}.png`,
    fullPage: true,
  });
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
