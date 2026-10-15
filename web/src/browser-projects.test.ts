import { afterEach, expect, test, vi } from "vitest";
import { browserProjects } from "../e2e/garage-target";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

test("keeps explicit browser projects available when a worker reloads configuration", () => {
  vi.stubEnv("GARAGE_BROWSER", undefined);
  process.argv = ["node", "playwright", "test", "--project=chromium", "--project=webkit"];
  const parentProjects = browserProjects();
  expect(parentProjects.map(({ name }) => name)).toContain("webkit");

  // Workers inherit the parent's environment, but do not receive its CLI arguments.
  process.argv = ["node", "workerProcessEntry.js"];
  expect(browserProjects()).toEqual(parentProjects);
});

test("defaults to Chromium when no browser or project is selected", () => {
  vi.stubEnv("GARAGE_BROWSER", undefined);
  process.argv = ["node", "playwright", "test"];
  expect(browserProjects().map(({ name }) => name)).toEqual(["chromium"]);
});

test("honors a browser selected through the environment", () => {
  vi.stubEnv("GARAGE_BROWSER", "webkit");
  process.argv = ["node", "playwright", "test"];
  expect(browserProjects().map(({ name }) => name)).toEqual(["webkit"]);
});
