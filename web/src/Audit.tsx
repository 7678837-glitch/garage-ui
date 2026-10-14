import type { CopyKey } from "./copy-en";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api/client";
import { isGarageDown } from "./garageDown";
import { copy, fill, translate } from "./i18n";

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

const columnLabel = {
  at: "ui.column.at",
  username: "ui.column.username",
  ip: "ui.column.ip",
  result: "ui.column.result",
  reason: "ui.column.reason",
  method: "ui.column.method",
  path: "ui.column.path",
  target: "ui.column.target",
  status: "ui.column.status",
} as const satisfies Record<AuditColumn, CopyKey>;

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
  return { message: copy("ui.audit.is.unavailable"), code: null };
}

async function loadAudit(filters: AuditFilters): Promise<AuditPage> {
  const page = await api<AuditPage>(`/api/audit${auditSearch(filters)}`);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.audit.is.unavailable"));
  }
  return page;
}

async function exportAudit(filters: AuditFilters): Promise<void> {
  const response = await fetch(`/api/audit/export${auditSearch(filters)}`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(fill(copy("ui.request.failed"), { status: response.status }));
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
    <section className="grid min-w-0 gap-4" aria-label={copy("nav.audit")} aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">{copy("nav.audit")}</h2>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        {FILTER_FIELDS.map(([key, label]) => (
          <label className="block text-sm" key={key}>
            {translate(label)}
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
        {copy("ui.export.audit")}</button>
      {exportFailed ? <p>{copy("ui.export.failed")}</p> : null}
      {view.busy ? <div className="h-16 border border-line" aria-label={copy("ui.loading.audit")} /> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.audit")}</p> : null}
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
            {copy("ui.retry")}</button>
        </>
      ) : null}
      {view.empty ? <p>{copy("ui.there.are.no.audit.events")}</p> : null}
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th className="py-2 pr-3 font-medium" key={column} scope="col">
                  {copy(columnLabel[column])}
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
      </div>
    </section>
  );
}
