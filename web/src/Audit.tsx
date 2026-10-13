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

async function loadAudit(): Promise<AuditPage> {
  const page = await api<AuditPage>("/api/audit");
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Audit is unavailable");
  }
  return page;
}

async function exportAudit(): Promise<void> {
  const response = await fetch("/api/audit/export", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`request failed (${response.status})`);
  }
}

export function Audit() {
  const listed = useQuery({
    queryKey: ["audit"],
    queryFn: loadAudit,
  });
  const [exportFailed, setExportFailed] = useState(false);
  const items = listed.data?.items ?? [];
  return (
    <section className="grid gap-4" aria-label="Audit">
      <h2 className="text-lg font-semibold">Audit</h2>
      <button
        className="w-fit border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setExportFailed(false);
          void exportAudit().catch(() => {
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
