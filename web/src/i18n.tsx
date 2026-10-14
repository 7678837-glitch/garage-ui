import { createContext, useContext, useState, type ReactNode } from "react";
import { en, type CopyKey } from "./copy-en";
import { zh } from "./copy-zh";

const storageKey = "garage-ui-language";

export type Language = "en" | "zh-CN";

const catalogs = { en, "zh-CN": zh } as const;

export function readLanguage(storage: Pick<Storage, "getItem">): Language {
  return storage.getItem(storageKey) === "zh-CN" ? "zh-CN" : "en";
}

export function writeLanguage(storage: Pick<Storage, "setItem">, language: Language): void {
  storage.setItem(storageKey, language);
}

type LanguageValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: CopyKey) => string;
};

const LanguageContext = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() =>
    typeof localStorage === "undefined" ? "en" : readLanguage(localStorage),
  );
  const setLanguage = (next: Language) => {
    setLanguageState(next);
    if (typeof localStorage !== "undefined") {
      writeLanguage(localStorage, next);
    }
  };
  const t = (key: CopyKey) => catalogs[language][key];
  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>
  );
}

export function useI18n(): LanguageValue {
  const value = useContext(LanguageContext);
  if (value) {
    return value;
  }
  return {
    language: "en",
    setLanguage: () => undefined,
    t: (key) => en[key],
  };
}

export function LanguageChooser() {
  const { language, setLanguage, t } = useI18n();
  return (
    <label className="block max-w-sm text-sm">
      {t("settings.language")}
      <select
        className="mt-1 w-full border border-ink px-2 py-1"
        value={language}
        onChange={(event) => {
          const next = event.target.value === "zh-CN" ? "zh-CN" : "en";
          setLanguage(next);
        }}
      >
        <option value="en">{t("language.english")}</option>
        <option value="zh-CN">{t("language.chinese")}</option>
      </select>
    </label>
  );
}
