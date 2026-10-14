import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { en, type CopyKey } from "./copy-en";
import { zh } from "./copy-zh";

const storageKey = "garage-ui-language";

export type Language = "en" | "zh-CN";

const catalogs = { en, "zh-CN": zh } as const;

let activeLanguage: Language = "en";

export function copy(key: CopyKey): string {
  return catalogs[activeLanguage][key];
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) => {
    const value = values[name];
    return value === undefined ? token : String(value);
  });
}

export function isCopyKey(value: string): value is CopyKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}

const englishKey = new Map<string, CopyKey>();
for (const key of Object.keys(en) as CopyKey[]) {
  if (!englishKey.has(en[key])) {
    englishKey.set(en[key], key);
  }
}

export function phrase(language: Language, value: string): string {
  if (isCopyKey(value)) {
    return catalogs[language][value];
  }
  const key = englishKey.get(value);
  if (!key) {
    return value;
  }
  return catalogs[language][key];
}

export function translate(value: string): string {
  return phrase(activeLanguage, value);
}

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
  const [language, setLanguageState] = useState<Language>(() => {
    const initial = typeof localStorage === "undefined" ? "en" : readLanguage(localStorage);
    activeLanguage = initial;
    return initial;
  });
  activeLanguage = language;
  useEffect(() => {
    activeLanguage = language;
    return () => {
      activeLanguage = "en";
    };
  }, [language]);
  const setLanguage = (next: Language) => {
    activeLanguage = next;
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

const utcInstant = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

export function formatInstant(value: string, language: Language): string {
  if (language === "en" || !utcInstant.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
    hourCycle: "h23",
  }).format(date);
}

const capacityScale = {
  PB: 15,
  TB: 12,
  GB: 9,
  MB: 6,
  KB: 3,
  B: 0,
} as const;

export type CapacityUnit = keyof typeof capacityScale;

const capacityOrder = ["PB", "TB", "GB", "MB", "KB"] as const;

const capacityUnitKey = {
  B: "unit.B",
  KB: "unit.KB",
  MB: "unit.MB",
  GB: "unit.GB",
  TB: "unit.TB",
  PB: "unit.PB",
} as const satisfies Record<CapacityUnit, CopyKey>;

export function unitCopyKey(unit: CapacityUnit): CopyKey {
  return capacityUnitKey[unit];
}

function capacityFraction(digits: string, scale: number): string {
  const whole = digits.length > scale ? digits.slice(0, digits.length - scale) : "0";
  let fraction = digits.length > scale ? digits.slice(digits.length - scale) : digits.padStart(scale, "0");
  if (fraction.length < 2) {
    fraction = fraction.padEnd(2, "0");
  } else {
    let end = fraction.length;
    while (end > 2 && fraction[end - 1] === "0") {
      end -= 1;
    }
    fraction = fraction.slice(0, end);
  }
  return `${whole}.${fraction}`;
}

// Split the original digit text on decimal units. Avoid Number so byte counts past 2^53 are not rounded.
export function formatCapacity(digits: string, language: Language): string {
  const normalized = digits.replace(/^0+(?=\d)/, "");
  for (const unit of capacityOrder) {
    const scale = capacityScale[unit];
    if (normalized.length > scale) {
      return `${capacityFraction(normalized, scale)} ${catalogs[language][capacityUnitKey[unit]]}`;
    }
  }
  return `${normalized} ${catalogs[language][capacityUnitKey.B]}`;
}

export function CapacityText({ digits }: { digits: string }) {
  const { language } = useI18n();
  return <>{formatCapacity(digits, language)}</>;
}

export function InstantText({ value }: { value: string }) {
  const { language } = useI18n();
  return <time dateTime={value}>{formatInstant(value, language)}</time>;
}

export function LanguageChooser() {
  const { language, setLanguage, t } = useI18n();
  return (
    <label className="ui-field">
      {t("settings.language")}
      <select
        className="ui-input"
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
