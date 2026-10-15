import assert from "node:assert/strict";
import { browserProjects } from "../web/e2e/garage-target";

const originalArgv = process.argv;
const originalBrowser = process.env.GARAGE_BROWSER;

try {
  delete process.env.GARAGE_BROWSER;
  process.argv = ["node", "playwright", "test", "--project=chromium", "--project=webkit"];
  const parentProjects = browserProjects();
  assert.ok(parentProjects.some(({ name }) => name === "webkit"), "Explicit projects must include WebKit");

  // Workers inherit the parent's environment, but do not receive its CLI arguments.
  process.argv = ["node", "workerProcessEntry.js"];
  assert.deepEqual(browserProjects(), parentProjects, "Workers must retain the parent's browser projects");

  delete process.env.GARAGE_BROWSER;
  process.argv = ["node", "playwright", "test"];
  assert.deepEqual(browserProjects().map(({ name }) => name), ["chromium"], "The default browser must be Chromium");

  process.env.GARAGE_BROWSER = "webkit";
  assert.deepEqual(browserProjects().map(({ name }) => name), ["webkit"], "The selected environment browser must be honored");

  console.log("Browser project regression checks passed (3 checks)");
} finally {
  process.argv = originalArgv;
  if (originalBrowser === undefined) delete process.env.GARAGE_BROWSER;
  else process.env.GARAGE_BROWSER = originalBrowser;
}
