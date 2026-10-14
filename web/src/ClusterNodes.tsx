import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, captureAuthGeneration, noteUnauthenticated } from "./api/client";
import { CapacityField } from "./CapacityField";
import { ConfirmDialog } from "./confirm";
import { DetailTabs } from "./DetailTabs";
import { isGarageDown } from "./garageDown";
import { detailAddressFromHash, hashForDetail, nodeTabs, useLocationHash } from "./Nav";
import { releaseHash } from "./unsaved";
import { DataCell, ResourceIdentity } from "./ui";
import { CompactCapacityText, copy, fill, translate } from "./i18n";

const HIDDEN = new Set([
  "layoutVersion",
  "lastSeenSecsAgo",
  "capacity",
  "dataPartition",
  "metadataPartition",
  "role",
  "zone",
  "tags",
]);

function unavailableMessage(): string {
  return copy("ui.nodes.are.unavailable");
}
function connectFailedMessage(): string {
  return copy("ui.connection.failed");
}
function previewFailedMessage(): string {
  return copy("ui.layout.preview.failed");
}
function historyFailedMessage(): string {
  return copy("ui.layout.history.failed");
}

type LayoutPreview = { phase: "idle" | "loading" } | { phase: "ready" } | { phase: "failed"; message: string };

type LayoutVersionRow = { version: number; status: string };

type LayoutTrackerRow = { id: string; ack: number; sync: number; syncAck: number };

type LayoutHistory =
  | { phase: "idle" | "loading" }
  | { phase: "ready"; versions: LayoutVersionRow[]; trackers: LayoutTrackerRow[] }
  | { phase: "failed"; message: string };

function csrfToken(): string {
  const found = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("garage_csrf="));
  if (!found) {
    return "";
  }
  return decodeURIComponent(found.slice("garage_csrf=".length));
}

async function previewFailureMessage(response: Response): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return previewFailedMessage();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return previewFailedMessage();
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "string") {
    return previewFailedMessage();
  }
  return message;
}

async function previewLayout(): Promise<LayoutPreview> {
  const response = await fetch("/api/layout/preview", {
    method: "POST",
    credentials: "include",
    headers: { "x-csrf-token": csrfToken() },
  });
  if (response.ok) {
    return { phase: "ready" };
  }
  return { phase: "failed", message: await previewFailureMessage(response) };
}

function historyMessage(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) {
    return historyFailedMessage();
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "string") {
    return historyFailedMessage();
  }
  return message;
}

function integerOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function versionRows(value: unknown): LayoutVersionRow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: LayoutVersionRow[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const version = integerOf((item as { version?: unknown }).version);
    const status = (item as { status?: unknown }).status;
    if (version === null || typeof status !== "string") {
      continue;
    }
    rows.push({ version, status });
  }
  return rows;
}

function trackerRows(value: unknown): LayoutTrackerRow[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const rows: LayoutTrackerRow[] = [];
  for (const [id, tracker] of Object.entries(value)) {
    if (typeof tracker !== "object" || tracker === null) {
      continue;
    }
    const ack = integerOf((tracker as { ack?: unknown }).ack);
    const sync = integerOf((tracker as { sync?: unknown }).sync);
    const syncAck = integerOf((tracker as { syncAck?: unknown }).syncAck);
    if (ack === null || sync === null || syncAck === null) {
      continue;
    }
    rows.push({ id, ack, sync, syncAck });
  }
  return rows;
}

function layoutHistoryFrom(parsed: unknown): LayoutHistory {
  if (typeof parsed !== "object" || parsed === null) {
    return { phase: "failed", message: historyFailedMessage() };
  }
  const versions = versionRows((parsed as { versions?: unknown }).versions);
  if (versions === null) {
    return { phase: "failed", message: historyMessage(parsed) };
  }
  return {
    phase: "ready",
    versions,
    trackers: trackerRows((parsed as { updateTrackers?: unknown }).updateTrackers),
  };
}

async function loadLayoutHistory(): Promise<LayoutHistory> {
  const response = await fetch("/api/layout/history", {
    method: "GET",
    credentials: "include",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return { phase: "failed", message: historyFailedMessage() };
  }
  if (!response.ok) {
    return { phase: "failed", message: historyMessage(parsed) };
  }
  return layoutHistoryFrom(parsed);
}

type NodeLine = {
  id: string;
  hostname: string | null;
  addr: string | null;
  garageVersion: string | null;
  isUp: boolean;
  draining: boolean;
  capacity: string | null;
};

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
  let cursor = index;
  while (cursor < text.length && " \n\r\t".includes(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function endOfContainer(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text[index] === '"') {
      index = endOfString(text, index);
      continue;
    }
    if (text[index] === open) {
      depth += 1;
    } else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return text.length;
}

function endOfValue(text: string, index: number): number {
  const mark = text[index];
  if (mark === '"') {
    return endOfString(text, index);
  }
  if (mark === "{") {
    return endOfContainer(text, index, "{", "}");
  }
  if (mark === "[") {
    return endOfContainer(text, index, "[", "]");
  }
  let cursor = index;
  while (
    cursor < text.length &&
    !",}]".includes(text[cursor]) &&
    !" \n\r\t".includes(text[cursor])
  ) {
    cursor += 1;
  }
  return cursor;
}

function stringKey(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function withoutTrailingComma(text: string): string | null {
  const match = /,\s*$/.exec(text);
  if (!match) {
    return null;
  }
  return text.slice(0, text.length - match[0].length);
}

// JSON.parse collapses integers above 2^53-1 into a different value. Those fields do not enter the page.
function omitHiddenNumbers(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const quote = text.indexOf('"', index);
    if (quote < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, quote);
    const end = endOfString(text, quote);
    const raw = text.slice(quote, end);
    const key = stringKey(raw);
    const colon = skipWs(text, end);
    if (key === null || text[colon] !== ":" || !HIDDEN.has(key)) {
      out += raw;
      index = end;
      continue;
    }
    const valueEnd = endOfValue(text, skipWs(text, colon + 1));
    const kept = withoutTrailingComma(out);
    if (kept !== null) {
      out = kept;
      index = valueEnd;
      continue;
    }
    let next = skipWs(text, valueEnd);
    if (text[next] === ",") {
      next += 1;
    }
    index = next;
  }
  return out;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(unavailableMessage());
  }
  if (value.length === 0) {
    return null;
  }
  return value;
}

function objectEntries(
  text: string,
  open: number,
): { key: string; start: number; end: number }[] {
  if (text[open] !== "{") {
    return [];
  }
  const close = endOfContainer(text, open, "{", "}");
  const entries = [];
  let index = open + 1;
  while (index < close - 1) {
    index = skipWs(text, index);
    if (index >= close - 1 || text[index] === "}") {
      break;
    }
    if (text[index] !== '"') {
      return [];
    }
    const keyEnd = endOfString(text, index);
    const key = stringKey(text.slice(index, keyEnd));
    const colon = skipWs(text, keyEnd);
    if (key === null || text[colon] !== ":") {
      return [];
    }
    const valueStart = skipWs(text, colon + 1);
    const valueEnd = endOfValue(text, valueStart);
    entries.push({ key, start: valueStart, end: valueEnd });
    index = skipWs(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
    }
  }
  return entries;
}

function arrayElements(text: string, open: number): { start: number; end: number }[] {
  if (text[open] !== "[") {
    return [];
  }
  const close = endOfContainer(text, open, "[", "]");
  const items = [];
  let index = open + 1;
  while (index < close - 1) {
    index = skipWs(text, index);
    if (index >= close - 1 || text[index] === "]") {
      break;
    }
    const valueEnd = endOfValue(text, index);
    items.push({ start: index, end: valueEnd });
    index = skipWs(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
    }
  }
  return items;
}

// Capacity digits do not go through JSON.parse. They stay a byte string for CapacityField.
function roleCapacityById(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const root = skipWs(text, 0);
  const nodes = objectEntries(text, root).find((entry) => entry.key === "nodes");
  if (!nodes || text[nodes.start] !== "[") {
    return found;
  }
  for (const item of arrayElements(text, nodes.start)) {
    if (text[item.start] !== "{") {
      continue;
    }
    const fields = objectEntries(text, item.start);
    const idField = fields.find((entry) => entry.key === "id");
    const roleField = fields.find((entry) => entry.key === "role");
    if (!idField || !roleField || text[roleField.start] !== "{") {
      continue;
    }
    const id = stringKey(text.slice(idField.start, idField.end));
    const capacity = objectEntries(text, roleField.start).find((entry) => entry.key === "capacity");
    if (id === null || id.length === 0 || !capacity) {
      continue;
    }
    const digits = text.slice(capacity.start, capacity.end);
    if (/^[0-9]+$/.test(digits)) {
      found.set(id, digits);
    }
  }
  return found;
}

function parseNode(value: unknown): Omit<NodeLine, "capacity"> {
  if (typeof value !== "object" || value === null) {
    throw new Error(unavailableMessage());
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error(unavailableMessage());
  }
  if (typeof row.isUp !== "boolean" || typeof row.draining !== "boolean") {
    throw new Error(unavailableMessage());
  }
  return {
    id: row.id,
    hostname: optionalText(row.hostname),
    addr: optionalText(row.addr),
    garageVersion: optionalText(row.garageVersion),
    isUp: row.isUp,
    draining: row.draining,
  };
}

type ClusterStatus = {
  nodes: NodeLine[];
  layoutVersion: string | null;
};

function topLevelDigits(text: string, key: string): string | null {
  const root = skipWs(text, 0);
  if (text[root] !== "{") {
    return null;
  }
  const field = objectEntries(text, root).find((entry) => entry.key === key);
  if (!field) {
    return null;
  }
  const digits = text.slice(field.start, field.end);
  if (!/^[0-9]+$/.test(digits)) {
    return null;
  }
  return digits;
}

function incrementDigits(digits: string): string {
  const chars = digits.split("");
  let carry = 1;
  for (let index = chars.length - 1; index >= 0 && carry === 1; index -= 1) {
    const sum = Number(chars[index]) + carry;
    chars[index] = String(sum % 10);
    carry = Math.floor(sum / 10);
  }
  if (carry === 1) {
    chars.unshift("1");
  }
  return chars.join("");
}

function parseStatus(text: string): ClusterStatus {
  return {
    nodes: parseNodes(text),
    layoutVersion: topLevelDigits(text, "layoutVersion"),
  };
}

function parseNodes(text: string): NodeLine[] {
  const capacities = roleCapacityById(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(omitHiddenNumbers(text)) as unknown;
  } catch {
    throw new Error(unavailableMessage());
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(unavailableMessage());
  }
  const nodes = (parsed as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(unavailableMessage());
  }
  return nodes.map((value) => {
    const node = parseNode(value);
    return { ...node, capacity: capacities.get(node.id) ?? null };
  });
}

function stageCapacity(id: string, capacity: string): Promise<unknown> {
  return api("/api/layout/stage", {
    method: "POST",
    body: JSON.stringify({ id, capacity }),
  });
}

function applyLayout(): Promise<unknown> {
  return api("/api/layout/apply", { method: "POST" });
}

function revertLayout(): Promise<unknown> {
  return api("/api/layout/revert", { method: "POST" });
}

function skipDeadNodes(version: string, allowMissingData: boolean): Promise<unknown> {
  return api("/api/layout/skip-dead-nodes", {
    method: "POST",
    headers: { "x-confirm": "yes" },
    body: `{"allowMissingData":${allowMissingData},"version":${version}}`,
  });
}

type PendingBlockPurge = {
  id: string;
  hash: string;
};

function purgeBlocks(id: string, hash: string): Promise<unknown> {
  return api(`/api/nodes/${id}/blocks/purge`, {
    method: "POST",
    headers: { "x-confirm": "yes" },
    body: JSON.stringify([hash]),
  });
}

function snapshotMetadata(id: string): Promise<unknown> {
  return api(`/api/nodes/${encodeURIComponent(id)}/metadata-snapshot`, {
    method: "POST",
  });
}

function NodeBlockPurge({ id, onAsk, pending = false }: { id: string; onAsk: (hash: string) => void; pending?: boolean }) {
  const [hash, setHash] = useState("");
  return (
    <>
      <label className="block break-all">
        <span className="text-sm">{copy("ui.block.hash")}</span>
        <input
          aria-label={fill(copy("ui.block.hash.for"), { id })}
          className="ui-input"
          value={hash}
          onChange={(event) => {
            setHash(event.target.value);
          }}
        />
      </label>
      <button
        className="ui-button ui-button-danger max-w-full break-all"
        aria-label={fill(copy("ui.purge.blocks.on"), { id })}
        disabled={pending}
        type="button"
        onClick={() => {
          const next = hash.trim();
          if (next.length === 0 || pending) {
            return;
          }
          onAsk(next);
        }}
      >
        {copy("ui.purge")}</button>
    </>
  );
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

async function loadNodes(): Promise<ClusterStatus> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch("/api/cluster/status", { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    // The node list is parsed from the raw text and does not go through api(). The banner only recognizes error.code.
    throw new ApiError(failure.message, failure.code);
  }
  return parseStatus(text);
}

function connectLine(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return connectFailedMessage();
  }
  const row = value as Record<string, unknown>;
  if (row.success === true) {
    return copy("ui.connected");
  }
  if (typeof row.error === "string" && row.error.length > 0) {
    return row.error;
  }
  return connectFailedMessage();
}

async function connectNode(address: string): Promise<string[]> {
  const body = await api<unknown>("/api/cluster/connect", {
    method: "POST",
    body: JSON.stringify([address]),
  });
  if (!Array.isArray(body)) {
    throw new Error(connectFailedMessage());
  }
  return body.map(connectLine);
}

type NodeSort = "id" | "hostname";

type NodeQuery = {
  filter: string;
  sort: NodeSort;
};

function nodeSortFrom(value: string | null): NodeSort {
  return value === "hostname" ? "hostname" : "id";
}

function readNodeQuery(): NodeQuery {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: params.get("nodes") ?? "",
    sort: nodeSortFrom(params.get("nodesSort")),
  };
}

function writeNodeQuery(query: NodeQuery) {
  const params = new URLSearchParams(window.location.search);
  if (query.filter.length > 0) {
    params.set("nodes", query.filter);
  } else {
    params.delete("nodes");
  }
  if (query.sort === "hostname") {
    params.set("nodesSort", "hostname");
  } else {
    params.delete("nodesSort");
  }
  const search = params.toString();
  const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function shownCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code === null || error.code.length === 0) {
    return null;
  }
  return error.code;
}

function nodeMatches(node: NodeLine, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  const needle = filter.toLowerCase();
  if (node.id.toLowerCase().includes(needle)) {
    return true;
  }
  return node.hostname !== null && node.hostname.toLowerCase().includes(needle);
}

function orderedNodes(rows: NodeLine[], sort: NodeSort): NodeLine[] {
  if (sort === "id") {
    return rows;
  }
  return [...rows].sort((left, right) => {
    const byHost = (left.hostname ?? "")
      .toLowerCase()
      .localeCompare((right.hostname ?? "").toLowerCase());
    if (byHost !== 0) {
      return byHost;
    }
    return left.id.toLowerCase().localeCompare(right.id.toLowerCase());
  });
}

export function OperationNodeSelection({ route, all = false }: {
  route: "workers" | "block-errors";
  all?: boolean;
}) {
  const [, assignHash] = useLocationHash();
  const nodes = useQuery({ queryKey: ["cluster", "status"], queryFn: loadNodes });
  function navigate(event: React.MouseEvent<HTMLAnchorElement>, next: string) {
    event.preventDefault();
    if (releaseHash(next)) assignHash(next);
  }
  return (
    <section className="ui-panel ui-page" aria-label={copy("common.selectNode")} aria-busy={nodes.isPending}>
      <h3>{copy("common.selectNode")}</h3>
      {nodes.isPending ? <p role="status">{copy("ui.loading.nodes")}</p> : null}
      {nodes.error instanceof Error && !isGarageDown(nodes.error) ? <p role="alert">{nodes.error.message}</p> : null}
      {shownCode(nodes.error) ? <p className="ui-identifier">{shownCode(nodes.error)}</p> : null}
      {nodes.isError ? <button className="ui-button" onClick={() => { void nodes.refetch(); }}>{copy("ui.retry.nodes")}</button> : null}
      <div className="ui-actions">
        {all ? <a className="ui-button" href="#workers/*" onClick={(event) => navigate(event, "#workers/*")}>{translate("All nodes")}</a> : null}
        {nodes.data?.nodes.map(node => {
          const next = `#${route}/${encodeURIComponent(node.id)}`;
          return <a className="ui-button" key={node.id} href={next} aria-label={node.hostname ?? fill(copy("ui.node"), { id: node.id })} onClick={(event) => navigate(event, next)}>{node.hostname ?? (node.id.length > 15 ? `${node.id.slice(0, 8)}…${node.id.slice(-6)}` : node.id)}</a>;
        })}
      </div>
      {nodes.isSuccess && nodes.data.nodes.length === 0 ? <p>{copy("ui.there.are.no.nodes.connect.the.first.node")}</p> : null}
    </section>
  );
}

export function ClusterNodes() {
  const client = useQueryClient();
  const [hash, assignHash] = useLocationHash();
  const goHash = (next: string) => {
    if (!releaseHash(next)) {
      return;
    }
    assignHash(next);
  };
  const [address, setAddress] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const nodes = useQuery({
    queryKey: ["cluster", "status"],
    queryFn: loadNodes,
  });
  async function refreshLayout() {
    await client.invalidateQueries({ queryKey: ["cluster"] });
    const [preview, history] = await Promise.all([
      previewLayout().catch((error: unknown) => ({
        phase: "failed" as const,
        message: error instanceof Error ? error.message : previewFailedMessage(),
      })),
      loadLayoutHistory().catch((error: unknown) => ({
        phase: "failed" as const,
        message: error instanceof Error ? error.message : historyFailedMessage(),
      })),
    ]);
    setLayoutPreview(preview);
    setLayoutHistory(history);
  }
  async function refreshMaintenance() {
    await Promise.all([client.invalidateQueries({ queryKey: ["cluster"] }), client.invalidateQueries({ queryKey: ["nodes"] })]);
  }
  const stage = useMutation({
    onSuccess: refreshLayout,
    mutationFn: ({ id, capacity }: { id: string; capacity: string }) => stageCapacity(id, capacity),
  });
  const apply = useMutation({
    mutationFn: applyLayout,
    onSuccess: async () => {
      await refreshLayout();
      setApplyOpen(false);
    },
  });
  const revert = useMutation({ mutationFn: revertLayout, onSuccess: refreshLayout });
  const skip = useMutation({
    onSuccess: async () => { await refreshLayout(); setSkipStep(null); },
    mutationFn: ({ version, missing }: { version: string; missing: boolean }) =>
      skipDeadNodes(version, missing),
  });
  const [applyOpen, setApplyOpen] = useState(false);
  const [allowMissingData, setAllowMissingData] = useState(false);
  const [skipStep, setSkipStep] = useState<"risk" | "loss" | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<PendingBlockPurge | null>(null);
  const purge = useMutation({
    onSuccess: async () => { await refreshMaintenance(); setPurgeTarget(null); },
    mutationFn: (target: PendingBlockPurge) => purgeBlocks(target.id, target.hash),
  });
  const snapshot = useMutation({
    mutationFn: snapshotMetadata,
    onSuccess: refreshMaintenance,
  });
  const connect = useMutation({
    mutationFn: connectNode,
    onSuccess: async (next) => {
      setLines(next);
      await client.invalidateQueries({ queryKey: ["cluster", "status"] });
    },
  });
  const [query, setQuery] = useState(readNodeQuery);
  const [layoutPreview, setLayoutPreview] = useState<LayoutPreview>({ phase: "idle" });
  const [layoutHistory, setLayoutHistory] = useState<LayoutHistory>({ phase: "idle" });
  useEffect(() => {
    const sync = () => setQuery(readNodeQuery());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const rows = nodes.isSuccess ? nodes.data.nodes : [];
  const layoutVersion = nodes.isSuccess ? nodes.data.layoutVersion : null;
  const nextLayoutVersion = layoutVersion === null ? null : incrementDigits(layoutVersion);
  const writes = [stage, apply, revert, skip, purge, snapshot];
  const writing = writes.some(mutation => mutation.isPending);
  const layoutWriting = stage.isPending || apply.isPending || revert.isPending || skip.isPending;
  const shown = nodes.isSuccess
    ? orderedNodes(
        rows.filter((node) => nodeMatches(node, query.filter)),
        query.sort,
      )
    : [];
  const trimmed = address.trim();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed.length === 0 || connect.isPending) {
      return;
    }
    setLines(null);
    connect.mutate(trimmed);
  }
  const message = nodes.error instanceof Error ? nodes.error.message : unavailableMessage();
  const code = shownCode(nodes.error);
  const connectFailure = connect.error instanceof Error ? connect.error.message : connectFailedMessage();
  const detail = detailAddressFromHash(hash);
  const nodeDetail = detail?.resource === "node" ? detail : null;
  const openedNode =
    nodeDetail === null || !nodes.isSuccess
      ? null
      : (rows.find((node) => node.id === nodeDetail.id) ?? null);
  return (
    <section className="ui-page min-w-0" aria-label={copy("ui.cluster.nodes")}>
      {nodeDetail === null ? <header className="ui-page-header">
        <h2>{copy("ui.nodes")}</h2>
        {layoutVersion !== null ? <p className="ui-muted">{translate("Layout version")}: <span className="ui-identifier">{layoutVersion}</span></p> : null}
      </header> : null}
      <div aria-live="polite">
        {writing ? <p role="status">{copy("ui.working")}</p> : null}
        {writes.map((mutation, index) => mutation.error instanceof Error && !isGarageDown(mutation.error) ? <p key={index} role="alert">{mutation.error.message}</p> : null)}
        {!writing && writes.some(mutation => mutation !== snapshot && mutation.isSuccess) ? <p role="status">{copy("ui.saved")}</p> : null}
      </div>
      {nodeDetail ? (
        <DetailTabs
          label={fill(copy("ui.node"), { id: nodeDetail.id })}
          title={openedNode?.hostname ?? copy("ui.nodes")}
          identity={<ResourceIdentity id={nodeDetail.id} />}
          tabs={nodeTabs()}
          selected={nodeDetail.tab}
          hrefFor={(tab) => hashForDetail({ resource: "node", id: nodeDetail.id, tab })}
          onSelect={(tab) => {
            goHash(hashForDetail({ resource: "node", id: nodeDetail.id, tab }));
          }}
        >
          <div className="ui-actions"><a className="ui-button" href={`#workers/${encodeURIComponent(nodeDetail.id)}`}>{copy("nav.workers")}</a><a className="ui-button" href={`#block-errors/${encodeURIComponent(nodeDetail.id)}`}>{copy("nav.blockErrors")}</a></div>
          {openedNode && nodeDetail.tab === "information" ? (
            <>
              <dl className="ui-panel grid gap-4 sm:grid-cols-2">
                <div><dt>{copy("ui.node.address")}</dt><dd className="ui-identifier">{openedNode.addr ?? "—"}</dd></div>
                <div><dt>{copy("ui.version")}</dt><dd>{openedNode.garageVersion ?? "—"}</dd></div>
                <div><dt>{copy("ui.status")}</dt><dd><span className="ui-status">{openedNode.isUp ? copy("ui.up") : copy("ui.down")}</span>{openedNode.draining ? <p>{copy("ui.draining")}</p> : null}</dd></div>
                <div><dt>{copy("ui.capacity")}</dt><dd>{openedNode.capacity !== null ? <CompactCapacityText digits={openedNode.capacity} /> : "—"}</dd></div>
              </dl>
              <button
                className="ui-button"
                disabled={snapshot.isPending}
                type="button"
                onClick={() => {
                  if (!snapshot.isPending) snapshot.mutate(openedNode.id);
                }}
              >
                {copy("ui.snapshot.metadata")}</button>
              {snapshot.isSuccess && snapshot.variables === openedNode.id ? (
                <p>{copy("ui.metadata.snapshot.started")}</p>
              ) : null}
            </>
          ) : null}
          {openedNode && nodeDetail.tab === "statistics" && openedNode.capacity !== null ? (
            <dl><dt>{copy("ui.capacity")}</dt><dd><CompactCapacityText digits={openedNode.capacity} /></dd></dl>
          ) : null}
          {openedNode && nodeDetail.tab === "maintenance" ? (
            <div className="ui-panel ui-page">
            {openedNode.capacity !== null ? <CapacityField
              pending={layoutWriting}
              bytes={openedNode.capacity}
              submit={(capacity) => {
                if (!layoutWriting) stage.mutate({ id: openedNode.id, capacity });
              }}
            /> : null}
            <NodeBlockPurge pending={purge.isPending} id={openedNode.id} onAsk={(hash) => setPurgeTarget({id:openedNode.id,hash})} />
            </div>
          ) : null}
        </DetailTabs>
      ) : null}
      {nodeDetail === null ? (
        <>
      <div className="ui-toolbar">
        <label className="ui-field">
          <span className="text-sm">{copy("ui.filter.nodes")}</span>
          <input
            className="ui-input"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeNodeQuery(next);
            }}
          />
        </label>
        <label className="ui-field">
          <span className="text-sm">{copy("ui.sort.nodes")}</span>
          <select
            className="ui-input"
            value={query.sort}
            onChange={(event) => {
              const next = {
                filter: query.filter,
                sort: nodeSortFrom(event.target.value),
              };
              setQuery(next);
              writeNodeQuery(next);
            }}
          >
            <option value="id">Id</option>
            <option value="hostname">{copy("ui.hostname")}</option>
          </select>
        </label>
        <p>{copy("ui.default.order.is.id")}</p>
      </div>
        </>
      ) : null}
      {nodes.isPending ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.nodes")}>{copy("ui.loading.nodes")}</div>
      ) : null}
      {nodes.isError && !isGarageDown(nodes.error) ? (
        <>
          <p>{message}</p>
          {code ? <p>{code}</p> : null}
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void nodes.refetch();
            }}
          >
            {copy("ui.retry.nodes")}</button>
        </>
      ) : null}
      {nodeDetail === null && nodes.isSuccess && rows.length === 0 ? (
        <p>{copy("ui.there.are.no.nodes.connect.the.first.node")}</p>
      ) : null}
      {nodeDetail === null ? <details className="ui-disclosure"><summary>{copy("tab.maintenance")}</summary>
      <div className="grid gap-2">
        <div className="ui-actions">
          <button
            className="ui-button max-w-full whitespace-normal"
            disabled={snapshot.isPending}
            type="button"
            onClick={() => {
              if (!snapshot.isPending) snapshot.mutate("*");
            }}
          >
            {copy("ui.snapshot.every.node")}</button>
          <button
            className="ui-button max-w-full whitespace-normal"
            type="button"
            onClick={() => {
              setLayoutHistory({phase:"loading"});
              void loadLayoutHistory().then(setLayoutHistory).catch((error: unknown) => setLayoutHistory({phase:"failed",message:error instanceof Error ? error.message : historyFailedMessage()}));
            }}
          >
            {copy("ui.layout.history")}</button>
        </div>
        {snapshot.isSuccess && snapshot.variables === "*" ? (
          <p>{copy("ui.metadata.snapshot.started")}</p>
        ) : null}
        <div className="ui-actions">
          <button
            className="ui-button max-w-full whitespace-normal"
            type="button"
            onClick={() => {
              setLayoutPreview({phase:"loading"});
              void previewLayout().then(setLayoutPreview).catch((error: unknown) => setLayoutPreview({phase:"failed",message:error instanceof Error ? error.message : previewFailedMessage()}));
            }}
          >
            {copy("ui.preview.layout")}</button>
          <button
            className="ui-button ui-button-danger max-w-full whitespace-normal"
            type="button"
            disabled={layoutWriting || layoutPreview.phase !== "ready" || nextLayoutVersion === null}
            onClick={() => {
              if (layoutPreview.phase !== "ready" || nextLayoutVersion === null) {
                return;
              }
              setApplyOpen(true);
            }}
          >
            {copy("ui.apply.layout")}</button>
          <button
            className="ui-button max-w-full whitespace-normal"
            disabled={layoutWriting}
            type="button"
            onClick={() => {
              if (!layoutWriting) revert.mutate();
            }}
          >
            {copy("ui.revert.staged.changes")}</button>
        </div>
        <div className="ui-actions">
          <label className="ui-checkbox-field text-sm">
            <input
              type="checkbox"
              checked={allowMissingData}
              onChange={(event) => {
                setAllowMissingData(event.target.checked);
              }}
            />
            {copy("ui.allow.missing.data")}</label>
          <button
            className="ui-button ui-button-danger max-w-full whitespace-normal"
            type="button"
            disabled={layoutWriting || layoutVersion === null}
            onClick={() => {
              if (layoutVersion === null) {
                return;
              }
              setSkipStep("risk");
            }}
          >
            {copy("ui.skip.dead.nodes")}</button>
        </div>
        {layoutPreview.phase === "loading" || layoutHistory.phase === "loading" ? <p role="status">{copy("ui.working")}</p> : null}
        {layoutPreview.phase === "failed" ? <p>{layoutPreview.message}</p> : null}
        {layoutHistory.phase === "failed" ? <p>{layoutHistory.message}</p> : null}
        {layoutHistory.phase === "ready" ? (
          <>
            <ul>
              {layoutHistory.versions.map((row, index) => (
                <li key={index}>
                  <p>{row.version}</p>
                  <p>{row.status}</p>
                </li>
              ))}
            </ul>
            <ul>
              {layoutHistory.trackers.map((row) => (
                <li key={row.id}>
                  <p>{row.id}</p>
                  <p>{row.ack}</p>
                  <p>{row.sync}</p>
                  <p>{row.syncAck}</p>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <form className="ui-form" onSubmit={submit}>
        <label className="ui-field">
          <span className="text-sm">{copy("ui.node.address")}</span>
          <input
            className="ui-input"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <div className="ui-actions">
          <button
            className="ui-button ui-button-primary max-w-full whitespace-normal"
            type="submit"
            disabled={trimmed.length === 0 || connect.isPending}
          >
            {connect.isPending ? copy("ui.connecting") : copy("ui.connect.node")}
          </button>
        </div>
      </form>
      {connect.isError ? <p>{fill(copy("ui.connect"), { connectFailure: connectFailure })}</p> : null}
      {connect.isSuccess && lines !== null && lines.length === 0 ? <p>{copy("ui.connected")}</p> : null}
      {lines !== null && lines.length > 0 ? (
        <ul className="min-w-0">
          {lines.map((line, index) => (
            <li key={index} className="break-all">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
</details> : null}
      {nodeDetail === null && nodes.isSuccess && shown.length > 0 ? (
        <div className="ui-table-container" role="region" aria-label={translate("Node list")} tabIndex={0}>
          <table className="ui-table ui-table-records" role="table">
            <thead><tr role="row">
              <th scope="col">{copy("ui.hostname")}</th>
              <th scope="col">{copy("ui.status")}</th>
              <th scope="col">{copy("ui.capacity")}</th>
              <th scope="col">{copy("tab.maintenance")}</th>
            </tr></thead>
            <tbody role="rowgroup">
          {shown.map((node) => (
            <tr key={node.id} role="row">
              <DataCell label={copy("ui.hostname")} kind="identity"><a aria-label={`${node.hostname ?? "—"} · ${fill(copy("ui.node"), { id: node.id })}`} href={hashForDetail({resource:"node",id:node.id,tab:"information"})}>{node.hostname ?? "—"}</a>
                {node.id.length > 15 ? <details className="ui-identity-details"><summary className="ui-identifier">{node.id.slice(0, 8)}…{node.id.slice(-6)} <span className="ui-muted">{copy("common.fullId")}</span></summary><code className="ui-identifier">{node.id}</code></details> : <p className="ui-identifier">{node.id}</p>}
                {node.addr !== null ? <p className="ui-muted ui-identifier">{node.addr}</p> : null}
                {node.garageVersion !== null ? <p className="ui-muted">{node.garageVersion}</p> : null}
              </DataCell>
              <DataCell label={copy("ui.status")}>
                <p className="ui-status">{node.isUp ? copy("ui.up") : copy("ui.down")}</p>
                {node.draining ? <p>{copy("ui.draining")}</p> : null}
              </DataCell>
              <DataCell label={copy("ui.capacity")}>{node.capacity !== null ? <CompactCapacityText digits={node.capacity} /> : "—"}</DataCell>
              <DataCell label={copy("tab.maintenance")} kind="actions" className="ui-record-actions-wide"><details className="ui-disclosure">
                <summary>{copy("tab.maintenance")}</summary>
                <div className="ui-actions">
                  <a className="ui-button" href={`#workers/${encodeURIComponent(node.id)}`}>{copy("nav.workers")}</a>
                  <a className="ui-button" href={`#block-errors/${encodeURIComponent(node.id)}`}>{copy("nav.blockErrors")}</a>
                </div>
              {node.capacity !== null ? (
                <CapacityField
                  pending={layoutWriting}
                  bytes={node.capacity}
                  submit={(capacity) => {
                    if (!layoutWriting) stage.mutate({ id: node.id, capacity });
                  }}
                />
              ) : null}
              <NodeBlockPurge
                pending={purge.isPending}
                id={node.id}
                onAsk={(hash) => {
                  setPurgeTarget({ id: node.id, hash });
                }}
              />
              </details></DataCell>
            </tr>
          ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {purgeTarget !== null ? (
        <ConfirmDialog
          pending={purge.isPending}
          action="clear-block"
          name={purgeTarget.hash}
          scope={purgeTarget.id}
          consequence={purge.error instanceof Error ? `${copy("ui.object.data.will.be.lost")} ${purge.error.message}` : copy("ui.object.data.will.be.lost")}
          onCancel={() => {
            setPurgeTarget(null);
          }}
          onConfirm={() => {
            const target = purgeTarget;
            purge.mutate(target);
          }}
        />
      ) : null}
      {applyOpen && nextLayoutVersion !== null ? (
        <ConfirmDialog
          pending={apply.isPending}
          action="apply-layout"
          name={nextLayoutVersion}
          scope="cluster"
          consequence={apply.error instanceof Error ? `${copy("ui.this.applies.the.staged.layout")} ${apply.error.message}` : copy("ui.this.applies.the.staged.layout")}
          onCancel={() => {
            setApplyOpen(false);
          }}
          onConfirm={() => {
            apply.mutate();
          }}
        />
      ) : null}
      {skipStep === "risk" && layoutVersion !== null ? (
        <ConfirmDialog
          pending={skip.isPending}
          action="skip-dead-node"
          name={layoutVersion}
          scope="cluster"
          consequence={skip.error instanceof Error ? `${copy("ui.this.forces.layout.progress.past.dead.nodes")} ${skip.error.message}` : copy("ui.this.forces.layout.progress.past.dead.nodes")}
          onCancel={() => {
            setSkipStep(null);
          }}
          onConfirm={() => {
            const version = layoutVersion;
            if (allowMissingData) {
              setSkipStep("loss");
              return;
            }
            skip.mutate({ version, missing: false });
          }}
        />
      ) : null}
      {skipStep === "loss" && layoutVersion !== null ? (
        <ConfirmDialog
          pending={skip.isPending}
          action="skip-dead-node"
          name={layoutVersion}
          scope="cluster"
          consequence={skip.error instanceof Error ? `${copy("ui.data.may.be.lost")} ${skip.error.message}` : copy("ui.data.may.be.lost")}
          onCancel={() => {
            setSkipStep(null);
          }}
          onConfirm={() => {
            const version = layoutVersion;
            skip.mutate({ version, missing: true });
          }}
        />
      ) : null}
    </section>
  );
}
