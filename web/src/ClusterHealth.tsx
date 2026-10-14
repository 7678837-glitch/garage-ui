import { useQuery } from "@tanstack/react-query";
import { ApiError, api, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { formatCapacity, useI18n, type Language, copy, fill, translate, phrase } from "./i18n";

const COUNTS = [
  ["knownNodes", "Known nodes"],
  ["connectedNodes", "Connected nodes"],
  ["storageNodes", "Storage nodes"],
  ["storageNodesUp", "Storage nodes up"],
  ["partitions", "Partitions"],
  ["partitionsQuorum", "Partitions with quorum"],
  ["partitionsAllOk", "Partitions all ok"],
] as const;

type CountKey = (typeof COUNTS)[number][0];

const METRICS = [
  ["s3Requests", "S3 requests"],
  ["s3Errors", "S3 errors"],
  ["blockReadBytes", "Block read bytes"],
  ["blockWriteBytes", "Block write bytes"],
] as const;

type MetricKey = (typeof METRICS)[number][0];

type MetricsSummary = {
  s3Requests: number;
  s3Errors: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  notice: string | null;
};

type ClusterHealthReport = {
  status: string;
  knownNodes: number;
  connectedNodes: number;
  storageNodes: number;
  storageNodesUp: number;
  partitions: number;
  partitionsQuorum: number;
  partitionsAllOk: number;
};

const STATISTICS = [
  ["bucketCount", "Buckets", "count", "Bucket count is not set"],
  ["totalObjectCount", "Objects", "count", "Object count is not set"],
  ["totalObjectBytes", "Object bytes", "bytes", "Object bytes are not set"],
  ["dataAvail", "Data available", "bytes", "Data available is not set"],
  ["metadataAvail", "Metadata available", "bytes", "Metadata available is not set"],
] as const;

type StatisticDisplay = (typeof STATISTICS)[number][2];

type CountText = { kind: "digits"; text: string } | { kind: "unset" };

type ClusterStatistics = {
  bucketCount: CountText;
  totalObjectCount: CountText;
  totalObjectBytes: CountText;
  dataAvail: CountText;
  metadataAvail: CountText;
  incompleteAvailInfo: boolean;
};

const STAT_KEYS = new Set<string>([
  "bucketCount",
  "totalObjectCount",
  "totalObjectBytes",
  "dataAvail",
  "metadataAvail",
  "incompleteAvailInfo",
]);

type RawStat =
  | { kind: "digits"; text: string }
  | { kind: "unset" }
  | { kind: "bool"; value: boolean }
  | { kind: "other" };

function countOf(row: Record<string, unknown>, key: CountKey): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(copy("ui.cluster.health.is.unavailable"));
  }
  return value;
}

function metricOf(row: Record<string, unknown>, key: MetricKey): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(copy("ui.cluster.metrics.are.unavailable"));
  }
  return value;
}

function noticeText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(copy("ui.cluster.metrics.are.unavailable"));
  }
  return value;
}

function parseMetrics(body: unknown): MetricsSummary {
  if (typeof body !== "object" || body === null) {
    throw new Error(copy("ui.cluster.metrics.are.unavailable"));
  }
  const row = body as Record<string, unknown>;
  return {
    s3Requests: metricOf(row, "s3Requests"),
    s3Errors: metricOf(row, "s3Errors"),
    blockReadBytes: metricOf(row, "blockReadBytes"),
    blockWriteBytes: metricOf(row, "blockWriteBytes"),
    notice: noticeText(row.notice),
  };
}

function parseHealth(body: unknown): ClusterHealthReport {
  if (typeof body !== "object" || body === null) {
    throw new Error(copy("ui.cluster.health.is.unavailable"));
  }
  const row = body as Record<string, unknown>;
  if (typeof row.status !== "string" || row.status.length === 0) {
    throw new Error(copy("ui.cluster.health.is.unavailable"));
  }
  return {
    status: row.status,
    knownNodes: countOf(row, "knownNodes"),
    connectedNodes: countOf(row, "connectedNodes"),
    storageNodes: countOf(row, "storageNodes"),
    storageNodesUp: countOf(row, "storageNodesUp"),
    partitions: countOf(row, "partitions"),
    partitionsQuorum: countOf(row, "partitionsQuorum"),
    partitionsAllOk: countOf(row, "partitionsAllOk"),
  };
}

function failureFrom(text: string, status: number): { message: string; code: string | null } {
  const fallback = `request failed (${status})`;
  const empty = { message: fallback, code: null };
  if (!text.startsWith("{")) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return empty;
  }
  const body = parsed as Record<string, unknown>;
  const message =
    typeof body.message === "string" && body.message.length > 0 ? body.message : fallback;
  const code = typeof body.code === "string" && body.code.length > 0 ? body.code : null;
  return { message, code };
}

function countText(raw: RawStat | undefined): CountText {
  if (raw?.kind === "digits") {
    return { kind: "digits", text: raw.text };
  }
  return { kind: "unset" };
}

function shownStatistic(
  field: CountText,
  display: StatisticDisplay,
  unset: string,
  language: Language,
): string {
  if (field.kind === "unset") {
    return phrase(language, unset);
  }
  if (display === "bytes") {
    return formatCapacity(field.text, language);
  }
  return field.text;
}

// JSON.parse rounds 9007199254740993 to 9007199254740992. Keep statistic digits from the response text.
function readStatistics(text: string): ClusterStatistics {
  const found = new Map<string, RawStat>();
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const end = endOfString(text, index);
    const key = text.slice(index + 1, end - 1);
    index = end;
    if (text[end - 1] !== '"' || !STAT_KEYS.has(key)) {
      continue;
    }
    const colon = skipWs(text, index);
    if (text[colon] !== ":") {
      continue;
    }
    const valueAt = skipWs(text, colon + 1);
    const read = readRaw(text, valueAt);
    if (read === null) {
      continue;
    }
    found.set(key, read.raw);
    index = read.next;
  }
  const incomplete = found.get("incompleteAvailInfo");
  return {
    bucketCount: countText(found.get("bucketCount")),
    totalObjectCount: countText(found.get("totalObjectCount")),
    totalObjectBytes: countText(found.get("totalObjectBytes")),
    dataAvail: countText(found.get("dataAvail")),
    metadataAvail: countText(found.get("metadataAvail")),
    incompleteAvailInfo: incomplete?.kind === "bool" && incomplete.value,
  };
}

function readRaw(text: string, index: number): { raw: RawStat; next: number } | null {
  const absent = keywordAt(text, index, "null");
  if (absent !== null) {
    return { raw: { kind: "unset" }, next: absent };
  }
  const yes = keywordAt(text, index, "true");
  if (yes !== null) {
    return { raw: { kind: "bool", value: true }, next: yes };
  }
  const no = keywordAt(text, index, "false");
  if (no !== null) {
    return { raw: { kind: "bool", value: false }, next: no };
  }
  const numberEnd = endOfDigits(text, index);
  if (numberEnd !== index) {
    return { raw: { kind: "digits", text: text.slice(index, numberEnd) }, next: numberEnd };
  }
  if (text[index] !== '"') {
    return null;
  }
  const end = endOfString(text, index);
  if (text[end - 1] !== '"') {
    return { raw: { kind: "other" }, next: end };
  }
  const inner = text.slice(index + 1, end - 1);
  if (/^[0-9]+$/.test(inner)) {
    return { raw: { kind: "digits", text: inner }, next: end };
  }
  return { raw: { kind: "other" }, next: end };
}

function keywordAt(text: string, index: number, word: string): number | null {
  if (!text.startsWith(word, index)) {
    return null;
  }
  const next = text[index + word.length];
  if (
    next !== undefined &&
    ((next >= "0" && next <= "9") ||
      (next >= "A" && next <= "Z") ||
      (next >= "a" && next <= "z") ||
      next === "_")
  ) {
    return null;
  }
  return index + word.length;
}

function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function skipWs(text: string, index: number): number {
  while (index < text.length && " \n\r\t".includes(text[index])) {
    index += 1;
  }
  return index;
}

function endOfDigits(text: string, index: number): number {
  const start = index;
  while (index < text.length && text[index] >= "0" && text[index] <= "9") {
    index += 1;
  }
  if (index === start || (index < text.length && ".eE".includes(text[index]))) {
    return start;
  }
  return index;
}

function shownCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code === null || error.code.length === 0) {
    return null;
  }
  return error.code;
}

async function loadStatistics(): Promise<ClusterStatistics> {
  const response = await fetch("/api/cluster/statistics", {
    method: "GET",
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    // Statistics are parsed from the response text, not through api(). The banner only reads error.code.
    throw new ApiError(failure.message, failure.code);
  }
  return readStatistics(text);
}

export function ClusterHealth() {
  const { language } = useI18n();
  const health = useQuery({
    queryKey: ["cluster", "health"],
    queryFn: async () => parseHealth(await api<unknown>("/api/cluster/health")),
  });
  const statistics = useQuery({
    queryKey: ["cluster", "statistics"],
    queryFn: loadStatistics,
  });
  const metrics = useQuery({
    queryKey: ["cluster", "metrics"],
    queryFn: async () => parseMetrics(await api<unknown>("/api/metrics")),
  });
  const healthMessage =
    health.error instanceof Error ? health.error.message : copy("ui.cluster.health.is.unavailable");
  const statisticsMessage =
    statistics.error instanceof Error
      ? statistics.error.message
      : copy("ui.cluster.statistics.are.unavailable");
  const healthCode = shownCode(health.error);
  const statisticsCode = shownCode(statistics.error);

  return (
    <section className="ui-page" aria-label={copy("ui.cluster.health")}>
      <h2 className="text-lg font-semibold">{copy("ui.cluster.health")}</h2>
      {health.isPending ? (
        <div className="h-16 border border-line" aria-label={copy("ui.loading.cluster.health")} />
      ) : null}
      {health.isError && !isGarageDown(health.error) ? (
        <>
          <p>{healthMessage}</p>
          {healthCode ? <p>{healthCode}</p> : null}
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void health.refetch();
            }}
          >
            {copy("ui.retry.health")}</button>
        </>
      ) : null}
      {health.isSuccess ? (
        <dl className="ui-panel grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
          <div>
            <dt className="font-medium">{copy("ui.status")}</dt>
            <dd className="mt-1 text-lg font-semibold">{health.data.status}</dd>
          </div>
          {COUNTS.map(([key, label]) => (
            <div key={key}>
              <dt className="font-medium">{translate(label)}</dt>
              <dd className="mt-1 text-lg font-semibold">{health.data[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {statistics.isPending ? <p role="status">{copy("ui.working")}</p> : null}
      {statistics.isError && !isGarageDown(statistics.error) ? (
        <>
          <p>{fill(copy("ui.statistics"), { statisticsMessage: statisticsMessage })}</p>
          {statisticsCode ? <p>{statisticsCode}</p> : null}
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void statistics.refetch();
            }}
          >
            {copy("ui.retry.statistics")}</button>
        </>
      ) : null}
      {statistics.isSuccess ? (
        <>
          <dl className="ui-panel grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
            {STATISTICS.map(([key, label, display, unset]) => (
              <div key={key}>
                <dt className="font-medium">{translate(label)}</dt>
                <dd className="mt-1 text-lg font-semibold">{shownStatistic(statistics.data[key], display, unset, language)}</dd>
              </div>
            ))}
          </dl>
          {statistics.data.incompleteAvailInfo ? (
            <p>{copy("ui.available.space.may.be.lower.because.some.nodes")}</p>
          ) : null}
        </>
      ) : null}
      {metrics.isPending ? <p role="status">{copy("ui.working")}</p> : null}
      {metrics.isError && !isGarageDown(metrics.error) ? <div className="ui-alert"><p role="alert">{metrics.error instanceof Error ? metrics.error.message : copy("ui.cluster.metrics.are.unavailable")}</p><button className="ui-button" onClick={() => { void metrics.refetch(); }}>{copy("ui.retry")}</button></div> : null}
      {metrics.isSuccess ? (
        <>
          <dl className="ui-panel grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
            {METRICS.map(([key, label]) => (
              <div key={key}>
                <dt className="font-medium">{translate(label)}</dt>
                <dd className="mt-1 text-lg font-semibold">{metrics.data[key]}</dd>
              </div>
            ))}
          </dl>
          {metrics.data.notice ? <p>{metrics.data.notice}</p> : null}
        </>
      ) : null}
    </section>
  );
}
