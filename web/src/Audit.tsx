import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api/client";
import { isGarageDown } from "./garageDown";

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

function failureOf(error: unknown): { message: string; code: string | null } {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: "Audit is unavailable", code: null };
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
  const view = {
    busy: listed.isPending,
    refreshing: items.length > 0 && listed.isFetching && !listed.isPending,
    empty: Boolean(listed.data) && items.length === 0,
    failure: listed.isError ? failureOf(listed.error) : null,
  };
  return (
    <section className="grid gap-4" aria-label="Audit" aria-busy={view.busy}>
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
      {view.busy ? <div className="h-16 border border-line" aria-label="Loading audit" /> : null}
      {view.refreshing ? <p>Refreshing audit</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void listed.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {view.empty ? <p>There are no audit events.</p> : null}
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
