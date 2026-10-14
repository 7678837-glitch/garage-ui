import { Button, Table } from "@radix-ui/themes";
import { useId, useState, type ReactNode, type TdHTMLAttributes } from "react";
import { fill, useI18n } from "./i18n";

export function Pagination({ page, hasPrevious, hasNext, pending = false, onPrevious, onNext }: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  pending?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  return <nav className="ui-pagination" aria-label={t("common.pagination")}>
    <span className="ui-muted">{fill(t("common.page"), { page })}</span>
    <Button size="2" color="gray" variant="soft" type="button" disabled={!hasPrevious || pending} onClick={onPrevious}>{t("common.previousPage")}</Button>
    <Button size="2" color="gray" variant="soft" type="button" disabled={!hasNext || pending} onClick={onNext}>{t("common.nextPage")}</Button>
  </nav>;
}

export function ResourceIdentity({ id, name, compact = false }: { id: string; name?: string; compact?: boolean }) {
  const { t } = useI18n();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const abbreviated = id.length > 15 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  const copyButton = <Button size="2" variant="ghost" type="button" onClick={async () => {
    setResult(null);
    try { await navigator.clipboard.writeText(id); setResult("copied"); }
    catch { setResult("failed"); }
  }}>{t("common.copyId")}</Button>;
  return <div className={`ui-resource-identity${compact ? " ui-resource-identity-compact" : ""}`}>
    {name ? <span className="ui-resource-name">{name}</span> : null}
    <div className="ui-actions">
      <details className="ui-identity-details">
        <summary><span className="ui-identifier">{abbreviated}</span><span className="ui-muted">{t("common.fullId")}</span></summary>
        <code className="ui-identifier">{id}</code>
        {compact ? copyButton : null}
      </details>
      {compact ? null : copyButton}
    </div>
    {result === "copied" ? <p role="status" className="ui-muted">{t("common.idCopied")}</p> : null}
    {result === "failed" ? <p role="alert" className="text-danger">{t("common.idCopyFailed")}</p> : null}
  </div>;
}

export function SettingsSection({ title, description, danger = false, children }: {
  title: string; description?: ReactNode; danger?: boolean; children: ReactNode;
}) {
  const id = useId();
  return <section className={`ui-settings-section${danger ? " ui-settings-danger" : ""}`} aria-labelledby={id}>
    <header><h3 id={id}>{title}</h3>{description ? <p className="ui-muted">{description}</p> : null}</header>
    <div className="ui-settings-controls">{children}</div>
  </section>;
}

export function DataCell({ label, kind = "metadata", children, className = "", width, ...props }: TdHTMLAttributes<HTMLTableCellElement> & {
  label: ReactNode; kind?: "selection" | "identity" | "metadata" | "actions";
}) {
  return <Table.Cell {...props} width={width === undefined ? undefined : String(width)} role="cell" data-kind={kind} className={`ui-data-cell ${className}`}>
    <span className="ui-data-label" aria-hidden="true">{label}</span>
    <div className="ui-data-value">{children}</div>
  </Table.Cell>;
}
