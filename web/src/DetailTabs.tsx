import { Tabs } from "@radix-ui/themes";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { translate } from "./i18n";

export function DetailTabs<T extends string>({ label, tabs, selected, hrefFor, onSelect, title, identity, children }: {
  label: string;
  title?: string;
  identity?: ReactNode;
  tabs: readonly { id: T; label: string }[];
  selected: T;
  hrefFor: (tab: T) => string;
  onSelect: (tab: T) => void;
  children: ReactNode;
}) {
  return <section className="ui-page" aria-label={translate(label)}>
    <header className="ui-page-header"><div><h2>{title ?? translate(label)}</h2>{identity}</div></header>
    <Tabs.Root value={selected} onValueChange={(value) => onSelect(value as T)}>
      <Tabs.List tabIndex={-1} aria-label={translate(label)} className="ui-detail-tabs">
        {tabs.map((tab) =>
          // Themes 3.3 forces button triggers; the primitive preserves shareable hash anchors.
          <TabsPrimitive.Trigger key={tab.id} value={tab.id} asChild>
            <a href={hrefFor(tab.id)} tabIndex={tab.id === selected ? 0 : -1} className="rt-reset rt-BaseTabListTrigger rt-TabsTrigger" onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                if (document.activeElement !== event.currentTarget) event.currentTarget.focus();
                else if (tab.id !== selected) onSelect(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (tab.id !== selected) onSelect(tab.id);
                }
              }}>
              <span className="rt-BaseTabListTriggerInner rt-TabsTriggerInner">{translate(tab.label)}</span>
              <span className="rt-BaseTabListTriggerInnerHidden rt-TabsTriggerInnerHidden" aria-hidden="true">{translate(tab.label)}</span>
            </a>
          </TabsPrimitive.Trigger>)}
      </Tabs.List>
      {tabs.map((tab) => <Tabs.Content key={tab.id} value={tab.id} tabIndex={0} className="ui-detail-panel">{tab.id === selected ? children : null}</Tabs.Content>)}
    </Tabs.Root>
  </section>;
}
