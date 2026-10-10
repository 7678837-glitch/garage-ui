import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "./api/client";

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

function parseNode(value: unknown): NodeLine {
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
  return nodes.map(parseNode);
}

function messageFrom(text: string, status: number): string {
  const fallback = `request failed (${status})`;
  if (!text.startsWith("{")) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
  if (typeof parsed === "object" && parsed && "message" in parsed) {
    const message = parsed.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

async function loadNodes(): Promise<NodeLine[]> {
  const response = await fetch("/api/cluster/status", { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(messageFrom(text, response.status));
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

export function ClusterNodes() {
  const client = useQueryClient();
  const [address, setAddress] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const nodes = useQuery({
    queryKey: ["cluster", "status"],
    queryFn: loadNodes,
  });
  const connect = useMutation({
    mutationFn: connectNode,
    onSuccess: async (next) => {
      setLines(next);
      await client.invalidateQueries({ queryKey: ["cluster", "status"] });
    },
  });
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
          Connect node
        </button>
      </form>
      {connect.isError ? <p>{`Connect: ${connectFailure}`}</p> : null}
      {lines !== null && lines.length > 0 ? (
        <ul className="min-w-0">
          {lines.map((line, index) => (
            <li key={index} className="break-all">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {nodes.isPending ? <p>Loading nodes</p> : null}
      {nodes.isError ? <p>{message}</p> : null}
      {nodes.isSuccess && nodes.data.length === 0 ? <p>There are no nodes.</p> : null}
      {nodes.isSuccess && nodes.data.length > 0 ? (
        <ul className="grid min-w-0 gap-3 text-sm">
          {nodes.data.map((node) => (
            <li key={node.id} className="min-w-0">
              <p className="break-all">{node.id}</p>
              {node.hostname !== null ? <p className="break-all">{node.hostname}</p> : null}
              {node.addr !== null ? <p className="break-all">{node.addr}</p> : null}
              {node.garageVersion !== null ? <p>{node.garageVersion}</p> : null}
              <p>{node.isUp ? "Up" : "Down"}</p>
              {node.draining ? <p>Draining</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
