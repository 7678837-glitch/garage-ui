import { useId, type ReactNode } from "react";
import { translate } from "./i18n";

export function DetailTabs<T extends string>({ label, tabs, selected, hrefFor, onSelect, children }: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  selected: T;
  hrefFor: (tab: T) => string;
  onSelect: (tab: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  return <section className="ui-page" aria-label={translate(label)}>
    <header className="ui-page-header"><h2>{translate(label)}</h2></header>
    <div className="ui-tabs" role="tablist" aria-label={translate(label)}>
      {tabs.map((tab, index) => <a key={tab.id} id={`${id}-${tab.id}`} href={hrefFor(tab.id)} role="tab"
        aria-selected={tab.id === selected} aria-controls={`${id}-panel`} tabIndex={tab.id === selected ? 0 : -1} className="ui-tab"
        onClick={(event) => { event.preventDefault(); onSelect(tab.id); }}
        onKeyDown={(event) => {
          let next: number;
          if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
          else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = tabs.length - 1;
          else return;
          event.preventDefault();
          const target = event.currentTarget.parentElement?.querySelectorAll<HTMLAnchorElement>("[role=tab]")[next];
          target?.focus();
          target?.click();
        }}
      >{translate(tab.label)}</a>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${selected}`} tabIndex={0}>{children}</div>
  </section>;
}
