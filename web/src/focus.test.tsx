import { expect, test } from "vitest";

// Read the stylesheet through the test runtime without adding Node type dependencies.
const readFileSync = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs").readFileSync;

// Slice import.meta.url because jsdom rewrites file URLs and Vite transforms new URL.
function stylesheetPath(): string {
  const href = import.meta.url;
  const prefix = "file://";
  if (!href.startsWith(prefix)) {
    throw new Error(href);
  }
  const testPath = decodeURIComponent(href.slice(prefix.length));
  return `${testPath.slice(0, testPath.lastIndexOf("/"))}/index.css`;
}

function ruleFor(css: string, selector: string) {
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const match of blocks) {
    if (match[1].trim() === selector) {
      return { selector, body: match[2] };
    }
  }
  return undefined;
}

test("links share the button focus-visible outline", () => {
  const source = readFileSync(stylesheetPath(), "utf8");
  const rule = ruleFor(
    source,
    ':where(a, button, input, select, textarea, summary, [tabindex]):not([class*="rt-"]):focus-visible',
  );
  expect(rule).toBeDefined();
  expect(rule?.body).toContain("outline: 2px solid var(--accent)");
  expect(rule?.body).toContain("outline-offset: 3px");
});
