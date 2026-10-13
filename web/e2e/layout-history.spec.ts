import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { assertWidth } from "./layout";

const forbiddenParts = [
  "/layout/apply",
  "/layout/revert",
  "/layout/skip-dead-nodes",
  "/repair",
] as const;

const layoutStatus = /^(Current|Draining|Historical)$/;

function watchForbidden(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (forbiddenParts.some((part) => url.includes(part))) {
      seen.push(url);
    }
  });
  return seen;
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

test("opens layout history and leaves apply disabled", async ({ page }) => {
  test.setTimeout(120_000);
  const forbidden = watchForbidden(page);

  await logIn(page);
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Nodes and layout", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Cluster nodes" })).toBeVisible();

  const apply = page.getByRole("button", { name: "Apply layout", exact: true });
  await expect(apply).toBeVisible();
  await expect(apply).toBeDisabled();

  await page.getByRole("button", { name: "Layout history", exact: true }).click();
  const versionRow = page
    .getByRole("listitem")
    .filter({ has: page.getByText(layoutStatus) })
    .filter({ has: page.getByText(/^\d+$/) });
  await expect(versionRow.first()).toBeVisible();
  await expect(apply).toBeDisabled();
  expect(forbidden, `forbidden requests: ${forbidden.join(" ")}`).toEqual([]);

  await assertWidth(page, "layout-history", 1280);
  await assertWidth(page, "layout-history", 360);
  await expect(apply).toBeDisabled();
  expect(forbidden, `forbidden requests: ${forbidden.join(" ")}`).toEqual([]);
});
