import { useEffect, useState } from "react";

const sections = [
  { id: "overview", label: "Overview", adminOnly: false },
  { id: "buckets", label: "Buckets", adminOnly: false },
  { id: "keys", label: "Keys", adminOnly: false },
  { id: "users", label: "Users", adminOnly: true },
  { id: "tokens", label: "Admin tokens", adminOnly: true },
] as const;

export type SectionId = (typeof sections)[number]["id"];

export type BucketLocation =
  | { kind: "list" }
  | { kind: "objects"; bucketId: string; prefix: string };

function hashBody(hash: string): string {
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

// 地址来自浏览器。坏的百分号转义留在原段里，避免整页被 decodeURIComponent 打崩。
function decodeHashSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function sectionFromHash(hash: string, role: string): SectionId {
  const id = hashBody(hash).split("/")[0];
  const match = sections.find((section) => section.id === id);
  if (!match || (match.adminOnly && role !== "admin")) {
    return "overview";
  }
  return match.id;
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
