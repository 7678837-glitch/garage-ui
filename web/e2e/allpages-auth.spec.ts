import { assertRenderedLayout } from "./layout";
import { administrator } from "./accounts";
import { test, expect } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { assertAuthenticated, openAccount } from './interactions';
const dir = process.env.ALLPAGES_EVIDENCE ?? '/tmp/garage-ui-allpages-admin';
const username = administrator.username;
const password = administrator.password;
for (const width of [360, 390, 768, 1280])
    test(`login and account ${width}`, async ({ page }) => {
        mkdirSync(dir, { recursive: true });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/');
        await expect(page.getByRole('button', { name: /^(Create administrator|Log in)$/ })).toBeVisible();
        const setup = page.getByRole('button', { name: 'Create administrator', exact: true });
        if (await setup.isVisible()) {
            await page.screenshot({ path: `${dir}/setup-${width}.png`, fullPage: true });
            await setup.click();
            await expect(page.getByText('Username is required', { exact: true })).toBeVisible();
            await page.getByLabel('Username', { exact: true }).fill(username);
            await page.getByLabel('Password', { exact: true }).fill(password);
            await setup.click();
            await assertAuthenticated(page);
            await openAccount(page);
            await page.getByRole('button', { name: 'Log out', exact: true }).click();
        }
        await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
        await assertRenderedLayout(page, `login at ${width}`);
        await page.screenshot({ path: `${dir}/login-${width}.png`, fullPage: true });
        await page.screenshot({ path: `${dir}/login-${width}-viewport.png`, fullPage: false });
        await page.getByLabel('Username', { exact: true }).fill(username);
        await page.getByLabel('Password', { exact: true }).fill('incorrect-synthetic-password');
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await expect(page.locator('.text-danger').first()).toBeVisible();
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await assertAuthenticated(page);
        await openAccount(page);
        await assertRenderedLayout(page, `account at ${width}`);
        await page.screenshot({ path: `${dir}/account-${width}.png`, fullPage: false });
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        await openAccount(page);
        await page.getByRole('button', { name: 'Log out', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
        appendFileSync(`${dir}/actions.jsonl`, JSON.stringify({ page: 'Login/account', width, result: 'passed', actions: ['invalid login', 'valid login', 'account menu', 'logout'] }) + '\n');
    });
