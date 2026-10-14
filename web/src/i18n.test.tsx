import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Breadcrumb } from "./App";
import { en } from "./copy-en";
import { zh } from "./copy-zh";
import { InstantText, LanguageChooser, LanguageProvider } from "./i18n";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("english and chinese catalogs have the same keys", () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  expect(zhKeys).toEqual(enKeys);
  for (const key of enKeys) {
    const english = en[key as keyof typeof en];
    const chinese = zh[key as keyof typeof zh];
    expect(english.length).toBeGreaterThan(0);
    expect(chinese.length).toBeGreaterThan(0);
    expect(chinese).not.toBe(key);
    expect(chinese).not.toBe(english);
  }
});

test("switching to chinese replaces the language label", () => {
  localStorage.clear();
  render(
    <LanguageProvider>
      <LanguageChooser />
    </LanguageProvider>,
  );
  expect(screen.getByLabelText("Language")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh-CN" } });
  expect(screen.getByLabelText("语言")).toBeTruthy();
  expect(screen.queryByLabelText("Language")).toBeNull();
  expect(screen.queryByText("settings.language")).toBeNull();
});

test("a chinese breadcrumb names sections and tabs from the catalog", () => {
  localStorage.setItem("garage-ui-language", "zh-CN");
  const { unmount } = render(
    <LanguageProvider>
      <Breadcrumb section="keys" hash="#keys" onSelect={() => undefined} />
    </LanguageProvider>,
  );
  const keys = screen.getByRole("navigation", { name: "路径" });
  expect(within(keys).getByRole("link", { name: "概览" }).textContent).toBe("概览");
  expect(within(keys).getByText("密钥").textContent).toBe("密钥");
  expect(within(keys).queryByText("Overview")).toBeNull();
  expect(within(keys).queryByText("Keys")).toBeNull();
  unmount();

  render(
    <LanguageProvider>
      <Breadcrumb
        section="buckets"
        hash="#buckets/bucket-ada/photos/"
        onSelect={() => undefined}
      />
    </LanguageProvider>,
  );
  const objects = screen.getByRole("navigation", { name: "路径" });
  expect(within(objects).getByRole("link", { name: "概览" }).textContent).toBe("概览");
  expect(within(objects).getByRole("link", { name: "存储桶" }).textContent).toBe("存储桶");
  expect(within(objects).getByText("对象").textContent).toBe("对象");
  expect(objects.textContent).not.toContain("bucket-ada");

  cleanup();
  render(
    <LanguageProvider>
      <Breadcrumb section="buckets" hash="#bucket/b1/permissions" onSelect={() => undefined} />
    </LanguageProvider>,
  );
  const permissions = screen.getByRole("navigation", { name: "路径" });
  expect(within(permissions).getByText("权限").textContent).toBe("权限");
  expect(within(permissions).queryByText("Permissions")).toBeNull();
});

test("a timestamp follows the language and english keeps the source text", () => {
  localStorage.setItem("garage-ui-language", "zh-CN");
  const chinese = render(
    <LanguageProvider>
      <InstantText value="2026-10-11T00:00:00Z" />
    </LanguageProvider>,
  );
  expect(screen.getByText("2026年10月11日 00:00").textContent).toBe("2026年10月11日 00:00");
  expect(screen.queryByText("2026-10-11T00:00:00Z")).toBeNull();
  chinese.unmount();

  localStorage.setItem("garage-ui-language", "en");
  render(
    <LanguageProvider>
      <InstantText value="2026-10-11T00:00:00Z" />
    </LanguageProvider>,
  );
  expect(screen.getByText("2026-10-11T00:00:00Z").textContent).toBe("2026-10-11T00:00:00Z");
});
