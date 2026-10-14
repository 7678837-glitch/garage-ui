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
    <button className="ui-button" type="button" disabled={!hasPrevious || pending} onClick={onPrevious}>{t("common.previousPage")}</button>
    <button className="ui-button" type="button" disabled={!hasNext || pending} onClick={onNext}>{t("common.nextPage")}</button>
  </nav>;
}
