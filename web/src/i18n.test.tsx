import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { en } from "./copy-en";
import { zh } from "./copy-zh";
import { LanguageChooser, LanguageProvider } from "./i18n";

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
