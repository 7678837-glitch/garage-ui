import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminToken, garageTarget } from "./garage-target";

const target = garageTarget();
const dataDir = mkdtempSync(join(tmpdir(), "garage-ui-256-wizard-"));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const binary = join(repoRoot, "target/debug/garage-ui");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string" && key !== "HOST") {
    env[key] = value;
  }
}
delete env.HOST;
delete env.GARAGE_UI_BOOTSTRAP_USERNAME;
delete env.GARAGE_UI_BOOTSTRAP_PASSWORD_HASH;
env.DATA_DIR = dataDir;
env.GARAGE_ADMIN_URL = target.adminUrl;
env.GARAGE_ADMIN_TOKEN = adminToken(target.container);
env.S3_ENDPOINT_URL = target.s3Url;

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "**/wizard.spec.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3909",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `env -u HOST "${binary}"`,
    cwd: dataDir,
    env,
    url: "http://127.0.0.1:3909/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
