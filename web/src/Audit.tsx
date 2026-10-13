import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api/client";

const COLUMNS = [
  "at",
  "username",
  "ip",
  "result",
  "reason",
  "method",
  "path",
  "target",
  "status",
] as const;

type AuditColumn = (typeof COLUMNS)[number];

type AuditRow = Record<AuditColumn, string | number>;

type AuditPage = {
  items: AuditRow[];
  hasMore: boolean;
};

type AuditFilters = {
  user: string;
  from: string;
  to: string;
  action: string;
};

const FILTER_FIELDS = [
  ["user", "User"],
  ["from", "From"],
  ["to", "To"],
  ["action", "Action"],
] as const;

function auditSearch(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key] of FILTER_FIELDS) {
    const value = filters[key];
    if (value !== "") {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
}

async function loadAudit(filters: AuditFilters): Promise<AuditPage> {
  const page = await api<AuditPage>(`/api/audit${auditSearch(filters)}`);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Audit is unavailable");
  }
  return page;
}

async function exportAudit(filters: AuditFilters): Promise<void> {
  const response = await fetch(`/api/audit/export${auditSearch(filters)}`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`request failed (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "audit.csv";
  link.hidden = true;
  document.body.append(link);
  link.click();
  URL.revokeObjectURL(url);
}

export function Audit() {
  const [filters, setFilters] = useState<AuditFilters>({
    user: "",
    from: "",
    to: "",
    action: "",
  });
  const listed = useQuery({
    queryKey: ["audit", filters],
    queryFn: () => loadAudit(filters),
  });
  const [exportFailed, setExportFailed] = useState(false);
  const items = listed.data?.items ?? [];
  return (
    <section className="grid gap-4" aria-label="Audit">
      <h2 className="text-lg font-semibold">Audit</h2>
      <div className="flex flex-wrap items-end gap-3">
        {FILTER_FIELDS.map(([key, label]) => (
          <label className="block text-sm" key={key}>
            {label}
            <input
              className="mt-1 border border-line px-2 py-1"
              value={filters[key]}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const value = event.target.value;
                setFilters((current) => ({ ...current, [key]: value }));
              }}
            />
          </label>
        ))}
      </div>
      <button
        className="w-fit border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setExportFailed(false);
          void exportAudit(filters).catch(() => {
            setExportFailed(true);
          });
        }}
      >
        Export audit
      </button>
      {exportFailed ? <p>Export failed</p> : null}
      {listed.isError ? <p>Audit is unavailable</p> : null}
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th className="py-2 pr-3 font-medium" key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row, index) => (
            <tr key={`${row.at}-${row.path}-${index}`}>
              {COLUMNS.map((column) => (
                <td className="py-2 pr-3" key={column}>
                  {String(row[column] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
