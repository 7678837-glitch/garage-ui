const sections = [
  { id: "overview", label: "Overview", adminOnly: false },
  { id: "buckets", label: "Buckets", adminOnly: false },
  { id: "keys", label: "Keys", adminOnly: false },
  { id: "users", label: "Users", adminOnly: true },
] as const;

export type SectionId = (typeof sections)[number]["id"];

export function sectionFromHash(hash: string, role: string): SectionId {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  const match = sections.find((section) => section.id === id);
  if (!match || (match.adminOnly && role !== "admin")) {
    return "overview";
  }
  return match.id;
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
