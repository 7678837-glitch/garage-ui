import { Button, Theme } from "@radix-ui/themes";
import { useEffect, useState, type ReactNode } from "react";
import type { CopyKey } from "./copy-en";
import { useI18n } from "./i18n";

const themeStorageKey = "garage-ui-theme";
const colorSchemeQuery = "(prefers-color-scheme: dark)";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const themeOptions = [
  ["light", "theme.light"],
  ["dark", "theme.dark"],
  ["system", "theme.system"],
] as const satisfies ReadonlyArray<readonly [ThemeChoice, CopyKey]>;

export function readThemeChoice(storage: Pick<Storage, "getItem">): ThemeChoice {
  const value = storage.getItem(themeStorageKey);
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export function writeThemeChoice(storage: Pick<Storage, "setItem">, choice: ThemeChoice): void {
  storage.setItem(themeStorageKey, choice);
  window.dispatchEvent(new Event("garage-theme-change"));
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

function useThemeState() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(localStorage));
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => {
    const media = typeof window.matchMedia === "function" ? window.matchMedia(colorSchemeQuery) : null;
    const sync = () => { setChoice(readThemeChoice(localStorage)); setDark(media?.matches ?? false); };
    sync();
    media?.addEventListener("change", sync);
    window.addEventListener("garage-theme-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      media?.removeEventListener("change", sync);
      window.removeEventListener("garage-theme-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const resolved = resolveTheme(choice, dark);
  useEffect(() => { applyResolvedTheme(document.documentElement, resolved); }, [resolved]);
  return { choice, resolved };
}

export function useThemeSync() {
  return useThemeState().resolved;
}

export function GarageTheme({ children }: { children: ReactNode }) {
  const resolved = useThemeSync();
  return <Theme appearance={resolved} accentColor="orange" grayColor="gray" radius="medium">{children}</Theme>;
}

export function ThemeChooser() {
  const { choice } = useThemeState();
  const { t } = useI18n();
  return (
    <div className="ui-actions" role="group" aria-label={t("theme.group")}>
      {themeOptions.map(([option, label]) => (
        <Button key={option} size="2" color={choice === option ? "orange" : "gray"}
          variant={choice === option ? "solid" : "soft"} type="button" aria-pressed={choice === option}
          onClick={() => writeThemeChoice(localStorage, option)}>{t(label)}</Button>
      ))}
    </div>
  );
}
