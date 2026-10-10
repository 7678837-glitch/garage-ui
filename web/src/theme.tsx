import { useEffect, useState } from "react";

const themeStorageKey = "garage-ui-theme";
const colorSchemeQuery = "(prefers-color-scheme: dark)";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const themeOptions = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
] as const;

export function readThemeChoice(storage: Pick<Storage, "getItem">): ThemeChoice {
  const value = storage.getItem(themeStorageKey);
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export function writeThemeChoice(storage: Pick<Storage, "setItem">, choice: ThemeChoice): void {
  storage.setItem(themeStorageKey, choice);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "system") {
    return prefersDark ? "dark" : "light";
  }
  return choice;
}

function prefersDark(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(colorSchemeQuery).matches;
}

function applyResolvedTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.remove("light", "dark", "system");
  root.classList.add(resolved);
}

export function bootTheme(root: HTMLElement, storage: Pick<Storage, "getItem">): void {
  applyResolvedTheme(root, resolveTheme(readThemeChoice(storage), prefersDark()));
}

export function ThemeChooser() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(localStorage));
  const [prefersDarkScheme, setPrefersDarkScheme] = useState(prefersDark);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(colorSchemeQuery);
    const onChange = () => {
      setPrefersDarkScheme(media.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);
  const resolved = resolveTheme(choice, prefersDarkScheme);
  useEffect(() => {
    applyResolvedTheme(document.documentElement, resolved);
  }, [resolved]);
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
      {themeOptions.map(([option, label]) => (
        <button
          key={option}
          className="border border-ink px-3 py-1 text-left"
          type="button"
          aria-pressed={choice === option}
          onClick={() => {
            writeThemeChoice(localStorage, option);
            setChoice(option);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
