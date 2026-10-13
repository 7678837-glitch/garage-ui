import { expect, type Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

function csvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}

test("downloads the audit CSV from Export audit", async ({ page }) => {
  test.setTimeout(120_000);
  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Audit", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("audit.csv");
  const saved = await download.path();
  if (saved === null) {
    throw new Error("Export audit did not write a file");
  }
  const rows = csvRows(await readFile(saved, "utf8"));
  const header = rows[0] ?? [];
  expect(header).toContain("username");
  const usernameAt = header.indexOf("username");
  const usernames = rows.slice(1).map((row) => row[usernameAt]);
  expect(usernames).toContain(administrator.username);

  await expect(page.getByRole("cell", { name: administrator.username, exact: true }).first()).toBeVisible();
  await assertWidth(page, "audit-export", 1280);
  await assertWidth(page, "audit-export", 360);
});
