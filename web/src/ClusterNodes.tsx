import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, noteUnauthenticated } from "./api/client";
import { CapacityField } from "./CapacityField";
import { isGarageDown } from "./garageDown";

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

const UNAVAILABLE = "Nodes are unavailable";
const CONNECT_FAILED = "Connection failed";

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

// JSON.parse 会把超过 2^53-1 的整数收成另一个值。这些字段不进页面。
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
    throw new Error(UNAVAILABLE);
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

// 容量数字不进 JSON.parse，只作为 CapacityField 的字节串。
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
    throw new Error(UNAVAILABLE);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error(UNAVAILABLE);
  }
  if (typeof row.isUp !== "boolean" || typeof row.draining !== "boolean") {
    throw new Error(UNAVAILABLE);
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

function parseNodes(text: string): NodeLine[] {
  const capacities = roleCapacityById(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(omitHiddenNumbers(text)) as unknown;
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(UNAVAILABLE);
  }
  const nodes = (parsed as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(UNAVAILABLE);
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

async function loadNodes(): Promise<NodeLine[]> {
  const response = await fetch("/api/cluster/status", { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    // 节点列表按原文解析，不经过 api()。横幅只认 error.code。
    throw new ApiError(failure.message, failure.code);
  }
  return parseNodes(text);
}

function connectLine(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return CONNECT_FAILED;
  }
  const row = value as Record<string, unknown>;
  if (row.success === true) {
    return "Connected";
  }
  if (typeof row.error === "string" && row.error.length > 0) {
    return row.error;
  }
  return CONNECT_FAILED;
}

async function connectNode(address: string): Promise<string[]> {
  const body = await api<unknown>("/api/cluster/connect", {
    method: "POST",
    body: JSON.stringify([address]),
  });
  if (!Array.isArray(body)) {
    throw new Error(CONNECT_FAILED);
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

export function ClusterNodes() {
  const client = useQueryClient();
  const [address, setAddress] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const nodes = useQuery({
    queryKey: ["cluster", "status"],
    queryFn: loadNodes,
  });
  const stage = useMutation({
    mutationFn: ({ id, capacity }: { id: string; capacity: string }) => stageCapacity(id, capacity),
  });
  const connect = useMutation({
    mutationFn: connectNode,
    onSuccess: async (next) => {
      setLines(next);
      await client.invalidateQueries({ queryKey: ["cluster", "status"] });
    },
  });
  const [query, setQuery] = useState(readNodeQuery);
  useEffect(() => {
    const sync = () => setQuery(readNodeQuery());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = nodes.isSuccess
    ? orderedNodes(
        nodes.data.filter((node) => nodeMatches(node, query.filter)),
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
  const message = nodes.error instanceof Error ? nodes.error.message : UNAVAILABLE;
  const code = shownCode(nodes.error);
  const connectFailure = connect.error instanceof Error ? connect.error.message : CONNECT_FAILED;
  return (
    <section className="grid min-w-0 gap-4" aria-label="Cluster nodes">
      <h2 className="text-lg font-semibold">Nodes</h2>
      <form className="grid gap-3" onSubmit={submit}>
        <label className="block">
          <span className="text-sm">Node address</span>
          <input
            className="mt-1 w-full border border-line px-2 py-1"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <button
          className="border border-ink px-3 py-1 text-left"
          type="submit"
          disabled={trimmed.length === 0 || connect.isPending}
        >
          {connect.isPending ? "Connecting" : "Connect node"}
        </button>
      </form>
      {connect.isError ? <p>{`Connect: ${connectFailure}`}</p> : null}
      {connect.isSuccess && lines !== null && lines.length === 0 ? <p>Connected</p> : null}
      {lines !== null && lines.length > 0 ? (
        <ul className="min-w-0">
          {lines.map((line, index) => (
            <li key={index} className="break-all">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid max-w-sm gap-3">
        <label className="block">
          <span className="text-sm">Filter nodes</span>
          <input
            className="mt-1 w-full border border-line px-2 py-1"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeNodeQuery(next);
            }}
          />
        </label>
        <label className="block">
          <span className="text-sm">Sort nodes</span>
          <select
            className="mt-1 w-full border border-line px-2 py-1"
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
            <option value="hostname">Hostname</option>
          </select>
        </label>
        <p>Default order is Id.</p>
      </div>
      {nodes.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading nodes" />
      ) : null}
      {nodes.isError && !isGarageDown(nodes.error) ? (
        <>
          <p>{message}</p>
          {code ? <p>{code}</p> : null}
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void nodes.refetch();
            }}
          >
            Retry nodes
          </button>
        </>
      ) : null}
      {nodes.isSuccess && nodes.data.length === 0 ? (
        <p>There are no nodes. Connect the first node.</p>
      ) : null}
      {nodes.isSuccess && shown.length > 0 ? (
        <ul className="grid min-w-0 gap-3 text-sm">
          {shown.map((node) => (
            <li key={node.id} className="min-w-0">
              <p className="break-all">{node.id}</p>
              {node.hostname !== null ? <p className="break-all">{node.hostname}</p> : null}
              {node.addr !== null ? <p className="break-all">{node.addr}</p> : null}
              {node.garageVersion !== null ? <p>{node.garageVersion}</p> : null}
              <p>{node.isUp ? "Up" : "Down"}</p>
              {node.draining ? <p>Draining</p> : null}
              {node.capacity !== null ? (
                <CapacityField
                  bytes={node.capacity}
                  submit={(capacity) => {
                    stage.mutate({ id: node.id, capacity });
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
