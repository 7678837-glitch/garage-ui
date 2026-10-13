import { useEffect, useState } from "react";

const sections = [
  { id: "overview", label: "Overview", adminOnly: false },
  { id: "buckets", label: "Buckets", adminOnly: false },
  { id: "keys", label: "Keys", adminOnly: false },
  { id: "nodes", label: "Nodes and layout", adminOnly: true },
  { id: "workers", label: "Workers", adminOnly: true },
  { id: "block-errors", label: "Block errors", adminOnly: true },
  { id: "audit", label: "Audit", adminOnly: true },
  { id: "tokens", label: "Admin tokens", adminOnly: true },
  { id: "users", label: "Users", adminOnly: true },
  { id: "settings", label: "Settings", adminOnly: false },
] as const;

export type SectionId = (typeof sections)[number]["id"];

export function sectionTitle(id: SectionId): string {
  const match = sections.find((section) => section.id === id);
  return match ? match.label : id;
}

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

function labelOf<T extends string>(tabs: readonly { id: T; label: string }[], id: T): string {
  const found = tabs.find((tab) => tab.id === id);
  return found ? found.label : id;
}

export function detailTabLabel(address: DetailAddress): string {
  switch (address.resource) {
    case "bucket":
      return labelOf(bucketDetailTabs, address.tab);
    case "key":
      return labelOf(keyDetailTabs, address.tab);
    case "node":
      return labelOf(nodeDetailTabs, address.tab);
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

export function Nav({
  role,
  section,
  open,
  onToggle,
  onSelect,
}: {
  role: string;
  section: SectionId;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: SectionId) => void;
}) {
  const visible = sections.filter((item) => !item.adminOnly || role === "admin");
  return (
    <nav className="grid w-full content-start gap-2 sm:w-44 sm:shrink-0" aria-label="Sections">
      <button
        className="border border-ink px-3 py-1 text-left"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        Menu
      </button>
      {open ? (
        <div className="grid gap-2">
          {visible.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={section === item.id ? "page" : undefined}
              className={
                section === item.id
                  ? "block border border-ink px-3 py-1 font-semibold"
                  : "block border border-line px-3 py-1"
              }
              onClick={(event) => {
                event.preventDefault();
                onSelect(item.id);
              }}
            >
              {item.label}
            </a>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
