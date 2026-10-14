import type { ReactNode } from "react";
import { translate } from "./i18n";

export function DetailTabs<T extends string>({
  label,
  tabs,
  selected,
  hrefFor,
  onSelect,
  children,
}: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  selected: T;
  hrefFor: (tab: T) => string;
  onSelect: (tab: T) => void;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3" aria-label={translate(label)}>
      <h2 className="text-lg font-semibold">{translate(label)}</h2>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={translate(label)}>
        {tabs.map((tab) => {
          const current = tab.id === selected;
          return (
            <a
              key={tab.id}
              href={hrefFor(tab.id)}
              role="tab"
              aria-selected={current}
              className={
                current
                  ? "border border-ink px-3 py-1 font-semibold"
                  : "border border-line px-3 py-1"
              }
              onClick={(event) => {
                event.preventDefault();
                onSelect(tab.id);
              }}
            >
              {translate(tab.label)}
            </a>
          );
        })}
      </div>
      <div role="tabpanel">{children}</div>
    </section>
  );
}
