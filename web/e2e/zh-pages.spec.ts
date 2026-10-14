import { submitLogin } from "./login";
import { assertAuthenticated, openAccount, openNavigation, selectChoice } from "./interactions";
import { expect, type Page, test } from "@playwright/test";
import { administrator } from "./accounts";
import { recordLayout } from "./layout";

const pages = [
  ["概览", "zh-overview"],
  ["存储桶", "zh-buckets"],
  ["密钥", "zh-keys"],
  ["节点和布局", "zh-nodes"],
  ["工作线程", "zh-workers"],
  ["块错误", "zh-block-errors"],
  ["审计", "zh-audit"],
  ["管理令牌", "zh-admin-tokens"],
  ["用户", "zh-users"],
  ["设置", "zh-settings"],
] as const;

function sections(page: Page) {
  return page.getByRole("navigation", { name: "分区" });
}

test("chinese pages stay inside the viewport", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await submitLogin(page);
  await assertAuthenticated(page);

  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Settings", exact: true }).click();
  await selectChoice(page.getByLabel("Language"), "Chinese");
  await expect(page.getByLabel("语言")).toBeVisible();

  for (const [name, shot] of pages) {
    const link = sections(page).getByRole("link", { name, exact: true });
    await openNavigation(page);
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "page");
    await recordLayout(page, shot);
  }

  const overview = sections(page).getByRole("link", { name: "概览", exact: true });
  await openNavigation(page);
  await overview.click();
  await expect(overview).toHaveAttribute("aria-current", "page");
  await openAccount(page);
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
  await recordLayout(page, "zh-login");
});
