import { expect, test } from "vitest";

// 工程没有 @types/node，不能改 lockfile。测试进程用 getBuiltinModule 读样式表原文。
const readFileSync = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs").readFileSync;

// jsdom 会把 file URL 解析成 localhost，Vite 也会改写 new URL，所以只切 import.meta.url。
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
    const selectors = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (selectors.includes(selector)) {
      return { selectors, body: match[2] };
    }
  }
  return undefined;
}

test("links share the button focus-visible outline", () => {
  const source = readFileSync(stylesheetPath(), "utf8");
  const rule = ruleFor(source, "button:focus-visible");
  expect(rule?.selectors).toContain("a:focus-visible");
  expect(rule?.body).toContain("outline: 2px solid var(--ink)");
  expect(rule?.body).toContain("outline-offset: 2px");
});
