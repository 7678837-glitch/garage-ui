import { useEffect, useRef, useState } from "react";
import type { CopyKey } from "./copy-en";
import { useI18n } from "./i18n";

const sections = [
  { id: "overview", adminOnly: false },
  { id: "buckets", adminOnly: false },
  { id: "keys", adminOnly: false },
  { id: "nodes", adminOnly: true },
  { id: "workers", adminOnly: true },
  { id: "block-errors", adminOnly: true },
  { id: "audit", adminOnly: true },
  { id: "tokens", adminOnly: true },
  { id: "users", adminOnly: true },
  { id: "settings", adminOnly: false },
] as const;

export type SectionId = (typeof sections)[number]["id"];

export type BucketLocation =
  | { kind: "list" }
  | { kind: "objects"; bucketId: string; prefix: string };

function hashBody(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

// The hash comes from the browser. A bad percent-escape stays in that segment so one broken segment cannot blank the page.
function decodeHashSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const detailSectionByRoot: Record<string, SectionId | undefined> = {
  bucket: "buckets",
  key: "keys",
  node: "nodes",
};

export function sectionFromHash(hash: string, role: string): SectionId {
  const root = hashBody(hash).split("/")[0];
  const id = detailSectionByRoot[root] ?? root;
  const match = sections.find((section) => section.id === id);
  if (!match || (match.adminOnly && role !== "admin")) {
    return "overview";
  }
  return match.id;
}

function nodeIdUnder(hash: string, root: string): string | null {
  const parts = hashBody(hash).split("/");
  if (parts.length !== 2 || parts[0] !== root || parts[1] === "") {
    return null;
  }
  const id = decodeHashSegment(parts[1]);
  if (id.length === 0) {
    return null;
  }
  return id;
}

export function workersNodeId(hash: string): string | null {
  return nodeIdUnder(hash, "workers");
}

export function blockErrorsNodeId(hash: string): string | null {
  return nodeIdUnder(hash, "block-errors");
}

export function bucketLocationFromHash(hash: string): BucketLocation {
  const parts = hashBody(hash).split("/");
  if (parts[0] !== "buckets" || parts.length < 2 || parts[1] === "") {
    return { kind: "list" };
  }
  const bucketId = decodeHashSegment(parts[1]);
  if (parts.length === 2) {
    return { kind: "objects", bucketId, prefix: "" };
  }
  return {
    kind: "objects",
    bucketId,
    prefix: parts.slice(2).map(decodeHashSegment).join("/"),
  };
}

export function hashForObjects(bucketId: string, prefix: string): string {
  const id = encodeURIComponent(bucketId);
  if (prefix === "") {
    return `#buckets/${id}`;
  }
  const encoded = prefix
    .split("/")
    .map((segment) => (segment === "" ? "" : encodeURIComponent(segment)))
    .join("/");
  return `#buckets/${id}/${encoded}`;
}

const bucketDetailTabs = [
  { id: "overview", label: "Overview" },
  { id: "objects", label: "Objects" },
  { id: "permissions", label: "Permissions" },
  { id: "settings", label: "Settings" },
] as const;

const keyDetailTabs = [
  { id: "overview", label: "Overview" },
  { id: "buckets", label: "Buckets" },
  { id: "settings", label: "Settings" },
] as const;

const nodeDetailTabs = [
  { id: "information", label: "Information" },
  { id: "statistics", label: "Statistics" },
  { id: "maintenance", label: "Maintenance" },
] as const;

export type BucketDetailTab = (typeof bucketDetailTabs)[number]["id"];
export type KeyDetailTab = (typeof keyDetailTabs)[number]["id"];
export type NodeDetailTab = (typeof nodeDetailTabs)[number]["id"];

export type DetailAddress =
  | { resource: "bucket"; id: string; tab: BucketDetailTab }
  | { resource: "key"; id: string; tab: KeyDetailTab }
  | { resource: "node"; id: string; tab: NodeDetailTab };

export function bucketTabs(): typeof bucketDetailTabs {
  return bucketDetailTabs;
}

export function keyTabs(): typeof keyDetailTabs {
  return keyDetailTabs;
}

export function nodeTabs(): typeof nodeDetailTabs {
  return nodeDetailTabs;
}

const detailTabCopy = {
  bucket: {
    overview: "nav.overview",
    objects: "nav.objects",
    permissions: "tab.permissions",
    settings: "nav.settings",
  },
  key: {
    overview: "nav.overview",
    buckets: "nav.buckets",
    settings: "nav.settings",
  },
  node: {
    information: "tab.information",
    statistics: "tab.statistics",
    maintenance: "tab.maintenance",
  },
} as const satisfies {
  bucket: Record<BucketDetailTab, CopyKey>;
  key: Record<KeyDetailTab, CopyKey>;
  node: Record<NodeDetailTab, CopyKey>;
};

export function detailTabCopyKey(address: DetailAddress): CopyKey {
  switch (address.resource) {
    case "bucket":
      return detailTabCopy.bucket[address.tab];
    case "key":
      return detailTabCopy.key[address.tab];
    case "node":
      return detailTabCopy.node[address.tab];
  }
}

export function sectionForDetail(resource: DetailAddress["resource"]): SectionId {
  switch (resource) {
    case "bucket":
      return "buckets";
    case "key":
      return "keys";
    case "node":
      return "nodes";
  }
}

function listedTab<T extends string>(
  tabs: readonly { id: T; label: string }[],
  value: string,
): T | null {
  const found = tabs.find((tab) => tab.id === value);
  return found ? found.id : null;
}

export function detailAddressFromHash(hash: string): DetailAddress | null {
  const parts = hashBody(hash).split("/");
  if (parts.length !== 3 || parts[1] === "" || parts[2] === "") {
    return null;
  }
  const id = decodeHashSegment(parts[1]);
  if (id.length === 0) {
    return null;
  }
  if (parts[0] === "bucket") {
    const tab = listedTab(bucketDetailTabs, parts[2]);
    return tab === null ? null : { resource: "bucket", id, tab };
  }
  if (parts[0] === "key") {
    const tab = listedTab(keyDetailTabs, parts[2]);
    return tab === null ? null : { resource: "key", id, tab };
  }
  if (parts[0] === "node") {
    const tab = listedTab(nodeDetailTabs, parts[2]);
    return tab === null ? null : { resource: "node", id, tab };
  }
  return null;
}

export function hashForDetail(address: DetailAddress): string {
  return `#${address.resource}/${encodeURIComponent(address.id)}/${address.tab}`;
}

export function useLocationHash(): [string, (next: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const assign = (next: string) => {
    if (window.location.hash !== next) {
      window.location.hash = next;
    }
    setHash(next);
  };
  return [hash, assign];
}

const sectionCopy = {
  overview: "nav.overview",
  buckets: "nav.buckets",
  keys: "nav.keys",
  nodes: "nav.nodes",
  workers: "nav.workers",
  "block-errors": "nav.blockErrors",
  audit: "nav.audit",
  tokens: "nav.tokens",
  users: "nav.users",
  settings: "nav.settings",
} as const satisfies Record<SectionId, CopyKey>;

export function sectionCopyKey(id: SectionId): CopyKey {
  return sectionCopy[id];
}

export function Nav({ role, section, open, onToggle, onSelect }: {
  role: string;
  section: SectionId;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: SectionId) => boolean;
}) {
  const { t } = useI18n();
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 899px)").matches);
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 899px)");
    const changed = () => setMobile(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!mobile || !open) return;
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    close.current?.focus();
    const trigger = menu.current;
    return () => { element.close?.(); trigger?.focus(); };
  }, [mobile, open]);
  const groups: { label?: CopyKey; ids: SectionId[] }[] = [
    { ids: ["overview"] },
    { label: "nav.storage", ids: ["buckets", "keys"] },
    { label: "nav.cluster", ids: ["nodes", "workers", "block-errors"] },
    { label: "nav.administration", ids: ["users", "tokens", "audit"] },
    { ids: ["settings"] },
  ];
  const links = <nav className="console-nav" aria-label={t("nav.sections")}>
    <div className="console-wordmark"><img src="./brand/garage-ui.svg" width="32" height="32" alt="" />Garage UI</div>
    {groups.map((group, index) => {
      const visible = group.ids.filter((id) => !sections.find((item) => item.id === id)?.adminOnly || role === "admin");
      if (!visible.length) return null;
      return <div className="console-nav-group" key={index}>
        {group.label ? <p className="console-nav-group-label">{t(group.label)}</p> : null}
        {visible.map((id) => <a key={id} href={`#${id}`} aria-current={section === id ? "page" : undefined}
          className="console-nav-link" onClick={(event) => {
            event.preventDefault();
            if (onSelect(id) && mobile && open) onToggle();
          }}>{t(sectionCopy[id])}</a>)}
      </div>;
    })}
  </nav>;
  return <>
    <button ref={menu} className="ui-button console-menu" type="button" aria-expanded={mobile && open} aria-controls="console-navigation" onClick={onToggle}>{t("nav.menu")}</button>
    {mobile ? open ? <dialog ref={dialog} id="console-navigation" className="console-drawer" aria-modal="true" aria-label={t("nav.sections")}
      onCancel={(event) => { event.preventDefault(); onToggle(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onToggle(); } }}
      onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onToggle(); } }}
    ><button ref={close} type="button" className="ui-button console-drawer-close" onClick={onToggle}>{t("nav.close")}</button>{links}</dialog> : null : <aside id="console-navigation" className="console-sidebar">{links}</aside>}
  </>;
}
