import { Button, Table, TextField } from "@radix-ui/themes";
import type { CopyKey } from "./copy-en";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api/client";
import { DataCell, Pagination } from "./ui";
import { isGarageDown } from "./garageDown";
import { ReadableInstantText, copy, fill, translate } from "./i18n";

const COLUMNS = [
  "at",
  "result",
  "username",
  "ip",
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
  ["user", "ui.user"],
  ["from", "ui.from"],
  ["to", "ui.to"],
  ["action", "ui.audit.target"],
] as const;

function utcSeconds(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.0{1,3})?)?$/.test(value)) {
    throw new Error(translate("Enter a valid UTC date and time."));
  }
  const seconds = value.replace(/\.0{1,3}$/, "");
  const normalized = seconds.length === 16 ? `${seconds}:00` : seconds;
  const milliseconds = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== normalized) {
    throw new Error(translate("Enter a valid UTC date and time."));
  }
  return String(milliseconds / 1000);
}

export function auditSearch(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key] of FILTER_FIELDS) {
    const value = filters[key];
    if (value !== "") {
      params.set(key, key === "from" || key === "to" ? utcSeconds(value) : value);
    }
  }
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
}

function auditInstant(value: string | number): string {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return raw;
  const milliseconds = Number(raw) * 1000;
  if (!Number.isSafeInteger(milliseconds)) return raw;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return raw;
  const iso = date.toISOString();
  return /^\d{4}-/.test(iso) ? iso : raw;
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

async function loadAudit(filters: AuditFilters, offset: number): Promise<AuditPage> {
  const params = new URLSearchParams(auditSearch(filters).replace(/^\?/, ""));
  params.set("offset", String(offset));
  params.set("limit", "100");
  const page = await api<AuditPage>(`/api/audit?${params}`);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.audit.is.unavailable"));
  }
  return page;
}

async function exportAudit(filters: AuditFilters): Promise<void> {
  const url = `/api/audit/export${auditSearch(filters)}`;
  const response = await fetch(url, {
    method: "HEAD",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(fill(copy("ui.request.failed"), { status: response.status }));
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = "audit.csv";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

export function Audit() {
  const [filters, setFilters] = useState<AuditFilters>({
    user: "",
    from: "",
    to: "",
    action: "",
  });
  const [offset, setOffset] = useState(0);
  const [invalidInputs, setInvalidInputs] = useState<Record<string, boolean>>({});
  let filterError: string | null = Object.values(invalidInputs).some(Boolean) ? translate("Enter a valid UTC date and time.") : null;
  try { auditSearch(filters); } catch (error) { filterError = failureOf(error).message; }
  const listed = useQuery({
    queryKey: ["audit", filters, offset],
    queryFn: () => loadAudit(filters, offset),
    enabled: filterError === null,
  });
  const [exportFailed, setExportFailed] = useState(false);
  const items = listed.data?.items ?? [];
  const view = {
    busy: listed.isPending && filterError === null,
    refreshing: items.length > 0 && listed.isFetching && !listed.isPending,
    empty: Boolean(listed.data) && items.length === 0,
    failure: listed.isError ? failureOf(listed.error) : null,
  };
  return (
    <section className="ui-page" aria-label={copy("nav.audit")} aria-busy={view.busy}>
      <div className="ui-page-header"><h2>{copy("nav.audit")}</h2></div>
      <p className="ui-muted">{translate("Dates are in UTC.")}</p>
      <div className="ui-toolbar">
        {FILTER_FIELDS.map(([key, label]) => (
          <div className="ui-field" key={key}>
            <label htmlFor={`audit-filter-${key}`}>{copy(label)}</label>
            <TextField.Root size="2"
              id={`audit-filter-${key}`}
              aria-describedby={key === "action" ? "audit-target-hint" : undefined}
              type={key === "from" || key === "to" ? "datetime-local" : "text"}
              step={key === "from" || key === "to" ? 1 : undefined}
              aria-invalid={invalidInputs[key] || undefined}
              value={filters[key]}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const value = event.target.value;
                setInvalidInputs((current) => ({ ...current, [key]: !event.target.validity.valid }));
                setFilters((current) => ({ ...current, [key]: value }));
                setOffset(0);
              }}
            />
            {key === "action" ? <span id="audit-target-hint" className="ui-muted">{copy("ui.audit.target.hint")}</span> : null}
          </div>
        ))}
      <Button size="2" variant="soft" color="gray"
        type="button"
        disabled={filterError !== null}
        onClick={() => {
          setExportFailed(false);
          void exportAudit(filters).catch(() => {
            setExportFailed(true);
          });
        }}
      >
        {copy("ui.export.audit")}</Button>
      </div>
      {filterError ? <p className="ui-alert" role="alert">{filterError}</p> : null}
      {exportFailed ? <p>{copy("ui.export.failed")}</p> : null}
      {view.busy ? <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.audit")}>{copy("ui.loading.audit")}</div> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.audit")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void listed.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {view.empty ? <p>{copy("ui.there.are.no.audit.events")}</p> : null}
      <div className="ui-table-container" role="region" aria-label={translate("Audit events")} tabIndex={0}>
        <Table.Root className="ui-table ui-table-records ui-audit-table">
          <Table.Header role="rowgroup">
            <Table.Row role="row">
              {COLUMNS.map((column) => (
                <Table.ColumnHeaderCell key={column} scope="col">
                  {copy(columnLabel[column])}
                </Table.ColumnHeaderCell>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body role="rowgroup">
            {items.map((row, index) => (
              <Table.Row role="row" key={`${row.at}-${row.path}-${index}`}>
                {COLUMNS.map((column) => (
                  <DataCell label={copy(columnLabel[column])} kind={column === "at" ? "identity" : "metadata"} className={`ui-audit-${column}${column === "path" || column === "target" ? " ui-identifier" : ""}`} key={column}>
                    {column === "at" ? <ReadableInstantText value={auditInstant(row[column])} /> : String(row[column] ?? "")}
                  </DataCell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>
      <Pagination page={Math.floor(offset / 100) + 1} hasPrevious={offset > 0}
        hasNext={listed.data?.hasMore === true} pending={listed.isFetching || filterError !== null}
        onPrevious={() => setOffset(Math.max(0, offset - 100))}
        onNext={() => setOffset(offset + 100)} />
    </section>
  );
}
