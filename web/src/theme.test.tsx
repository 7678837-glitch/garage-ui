import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { bootTheme, readThemeChoice, resolveTheme, ThemeChooser, useThemeSync, writeThemeChoice } from "./theme";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

function stubMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<EventListener>();
  const media: MediaQueryList = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof listener === "function") {
        listeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof listener === "function") {
        listeners.delete(listener);
      }
    },
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    preferDark() {
      matches = true;
      for (const listener of listeners) {
        listener(new Event("change"));
      }
    },
  };
}

function pressed(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed");
}

test("treats a bad stored value as system, persists dark, and resolves system from the media query", () => {
  localStorage.setItem("garage-ui-theme", "nope");
  stubMedia(true);
  expect(readThemeChoice(localStorage)).toBe("system");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  bootTheme(document.documentElement, localStorage);
  expect(document.documentElement.className).toBe("dark");
  expect(document.documentElement.classList.contains("system")).toBe(false);
  expect(localStorage.getItem("garage-ui-theme")).toBe("nope");
  writeThemeChoice(localStorage, "dark");
  expect(localStorage.getItem("garage-ui-theme")).toBe("dark");
  expect(readThemeChoice(localStorage)).toBe("dark");
  localStorage.setItem("garage-ui-theme", "system");
  stubMedia(false);
  bootTheme(document.documentElement, localStorage);
  expect(document.documentElement.className).toBe("light");
});

test("pressing Dark sets the documentElement class and keeps it after remount", () => {
  stubMedia(false);
  const first = render(<ThemeChooser />);
  expect(pressed("System")).toBe("true");
  expect(pressed("Light")).toBe("false");
  expect(pressed("Dark")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(document.documentElement.className).toBe("dark");
  expect(document.documentElement.classList.contains("system")).toBe(false);
  expect(localStorage.getItem("garage-ui-theme")).toBe("dark");
  expect(pressed("Dark")).toBe("true");
  expect(pressed("Light")).toBe("false");
  expect(pressed("System")).toBe("false");
  first.unmount();
  document.documentElement.className = "";
  render(<ThemeChooser />);
  expect(document.documentElement.className).toBe("dark");
  expect(localStorage.getItem("garage-ui-theme")).toBe("dark");
  expect(pressed("Dark")).toBe("true");
});

test("system follows a later media query change", () => {
  const media = stubMedia(false);
  localStorage.setItem("garage-ui-theme", "system");
  render(<ThemeChooser />);
  expect(document.documentElement.className).toBe("light");
  act(() => {
    media.preferDark();
  });
  expect(document.documentElement.className).toBe("dark");
  expect(document.documentElement.classList.contains("system")).toBe(false);
});

test("pressing System removes a forced dark choice when the media query is light", () => {
  localStorage.setItem("garage-ui-theme", "dark");
  stubMedia(false);
  render(<ThemeChooser />);
  expect(document.documentElement.className).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "System" }));
  expect(document.documentElement.className).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(document.documentElement.classList.contains("system")).toBe(false);
  expect(localStorage.getItem("garage-ui-theme")).toBe("system");
  expect(pressed("System")).toBe("true");
  expect(pressed("Dark")).toBe("false");
});

test("system theme keeps tracking while appearance controls are unmounted", () => {
  const media = stubMedia(false);
  function Sync() { useThemeSync(); return null; }
  render(<Sync />);
  expect(document.documentElement.className).toBe("light");
  act(() => media.preferDark());
  expect(document.documentElement.className).toBe("dark");
  act(() => writeThemeChoice(localStorage, "light"));
  expect(document.documentElement.className).toBe("light");
});
