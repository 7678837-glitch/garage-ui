import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api/client";
import { isGarageDown } from "./garageDown";

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

const DECIMAL_UNITS = [
  ["PB", 15],
  ["TB", 12],
  ["GB", 9],
  ["MB", 6],
  ["KB", 3],
] as const;

type RawStat =
  | { kind: "digits"; text: string }
  | { kind: "unset" }
  | { kind: "bool"; value: boolean }
  | { kind: "other" };

function countOf(row: Record<string, unknown>, key: CountKey): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Cluster health is unavailable");
  }
  return value;
}

function parseHealth(body: unknown): ClusterHealthReport {
  if (typeof body !== "object" || body === null) {
    throw new Error("Cluster health is unavailable");
  }
  const row = body as Record<string, unknown>;
  if (typeof row.status !== "string" || row.status.length === 0) {
    throw new Error("Cluster health is unavailable");
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

function shownStatistic(field: CountText, display: StatisticDisplay, unset: string): string {
  if (field.kind === "unset") {
    return unset;
  }
  if (display === "bytes") {
    return formatBytes(field.text);
  }
  return field.text;
}

// JSON.parse 会把 9007199254740993 收成 9007199254740992。统计数字按响应原文保留。
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

// 按十进制单位切原文字。不用 Number，避免超过 2^53 的字节被舍入。
function formatBytes(bytes: string): string {
  const digits = bytes.replace(/^0+(?=\d)/, "");
  for (const [unit, scale] of DECIMAL_UNITS) {
    if (digits.length > scale) {
      return `${formatInUnit(digits, scale)} ${unit}`;
    }
  }
  return `${digits} B`;
}

function formatInUnit(bytes: string, scale: number): string {
  const whole = bytes.length > scale ? bytes.slice(0, bytes.length - scale) : "0";
  let fraction = bytes.length > scale ? bytes.slice(bytes.length - scale) : bytes.padStart(scale, "0");
  if (fraction.length < 2) {
    fraction = fraction.padEnd(2, "0");
  } else {
    let end = fraction.length;
    while (end > 2 && fraction[end - 1] === "0") {
      end -= 1;
    }
    fraction = fraction.slice(0, end);
  }
  return `${whole}.${fraction}`;
}

async function loadStatistics(): Promise<ClusterStatistics> {
  const response = await fetch("/api/cluster/statistics", {
    method: "GET",
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    // 统计响应按原文解析，不经过 api()。横幅只认 error.code。
    throw new ApiError(failure.message, failure.code);
  }
  return readStatistics(text);
}

export function ClusterHealth() {
  const health = useQuery({
    queryKey: ["cluster", "health"],
    queryFn: async () => parseHealth(await api<unknown>("/api/cluster/health")),
  });
  const statistics = useQuery({
    queryKey: ["cluster", "statistics"],
    queryFn: loadStatistics,
  });
  const healthMessage =
    health.error instanceof Error ? health.error.message : "Cluster health is unavailable";
  const statisticsMessage =
    statistics.error instanceof Error
      ? statistics.error.message
      : "Cluster statistics are unavailable";

  return (
    <section className="grid gap-4" aria-label="Cluster health">
      <h2 className="text-lg font-semibold">Cluster health</h2>
      {health.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading cluster health" />
      ) : null}
      {health.isError && !isGarageDown(health.error) ? <p>{healthMessage}</p> : null}
      {health.isSuccess ? (
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="font-medium">Status</dt>
            <dd>{health.data.status}</dd>
          </div>
          {COUNTS.map(([key, label]) => (
            <div key={key}>
              <dt className="font-medium">{label}</dt>
              <dd>{health.data[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {statistics.isError && !isGarageDown(statistics.error) ? (
        <p>{`Statistics: ${statisticsMessage}`}</p>
      ) : null}
      {statistics.isSuccess ? (
        <>
          <dl className="grid gap-2 text-sm">
            {STATISTICS.map(([key, label, display, unset]) => (
              <div key={key}>
                <dt className="font-medium">{label}</dt>
                <dd>{shownStatistic(statistics.data[key], display, unset)}</dd>
              </div>
            ))}
          </dl>
          {statistics.data.incompleteAvailInfo ? (
            <p>Available space may be lower because some nodes are disconnected.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
