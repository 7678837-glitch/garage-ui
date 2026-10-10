import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { encodeObjectKey } from "./App";
import { ApiError, api } from "./api/client";
import { bucketUrl } from "./BucketPermissions";

type ObjectEntry = {
  kind: "object";
  key: string;
  size: number;
  etag: string;
  lastModified: string;
};

type PrefixEntry = {
  kind: "prefix";
  prefix: string;
};

type Entry = ObjectEntry | PrefixEntry;

type ObjectPage = {
  prefix: string;
  entries: Entry[];
  next: string | null;
};

type SearchMatch = {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
};

type SearchPage = {
  matches: SearchMatch[];
  truncated: boolean;
  reason: "result_limit" | "page_limit" | null;
};

type ObjectMeta = {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
  contentType: string;
};

type SortChoice = "key" | "size" | "time";

type BrowseState = {
  prefix: string;
  next: string | null;
  sort: SortChoice;
  search: string | null;
  selected: string | null;
};

type Failure = {
  message: string;
  code: string | null;
};

const PAGE_LIMIT = "100";
const UNAVAILABLE = "Objects are unavailable";

const initialBrowse: BrowseState = {
  prefix: "",
  next: null,
  sort: "key",
  search: null,
  selected: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(UNAVAILABLE);
  }
  return value;
}

function requiredSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(UNAVAILABLE);
  }
  return value;
}

function parseObject(row: Record<string, unknown>): ObjectEntry {
  return {
    kind: "object",
    key: requiredString(row, "key"),
    size: requiredSize(row.size),
    etag: requiredString(row, "etag"),
    lastModified: requiredString(row, "lastModified"),
  };
}

function parseEntry(value: unknown): Entry {
  if (!isRecord(value)) {
    throw new Error(UNAVAILABLE);
  }
  if (value.kind === "prefix") {
    return { kind: "prefix", prefix: requiredString(value, "prefix") };
  }
  if (value.kind === "object") {
    return parseObject(value);
  }
  throw new Error(UNAVAILABLE);
}

function parseNext(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(UNAVAILABLE);
  }
  return value;
}

function parsePage(value: unknown): ObjectPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error(UNAVAILABLE);
  }
  return {
    prefix: requiredString(value, "prefix"),
    entries: value.entries.map(parseEntry),
    next: parseNext(value.next),
  };
}

function parseReason(value: unknown): SearchPage["reason"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (value === "result_limit" || value === "page_limit") {
    return value;
  }
  throw new Error(UNAVAILABLE);
}

function parseSearch(value: unknown): SearchPage {
  if (!isRecord(value) || !Array.isArray(value.matches) || typeof value.truncated !== "boolean") {
    throw new Error(UNAVAILABLE);
  }
  return {
    matches: value.matches.map((match) => {
      if (!isRecord(match)) {
        throw new Error(UNAVAILABLE);
      }
      return {
        key: requiredString(match, "key"),
        size: requiredSize(match.size),
        etag: requiredString(match, "etag"),
        lastModified: requiredString(match, "lastModified"),
      };
    }),
    truncated: value.truncated,
    reason: parseReason(value.reason),
  };
}

function parseMeta(value: unknown): ObjectMeta {
  if (!isRecord(value)) {
    throw new Error(UNAVAILABLE);
  }
  return {
    key: requiredString(value, "key"),
    size: requiredSize(value.size),
    etag: requiredString(value, "etag"),
    lastModified: requiredString(value, "lastModified"),
    contentType: requiredString(value, "contentType"),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await api<unknown>(path);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new Error(UNAVAILABLE);
  }
}

function listPath(bucketId: string, prefix: string, next: string | null): string {
  const params = new URLSearchParams();
  params.set("prefix", prefix);
  params.set("limit", PAGE_LIMIT);
  if (next !== null && next.length > 0) {
    params.set("next", next);
  }
  return `${bucketUrl(bucketId)}/objects?${params.toString()}`;
}

function searchPath(bucketId: string, prefix: string, q: string): string {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("prefix", prefix);
  return `${bucketUrl(bucketId)}/search?${params.toString()}`;
}

function metadataPath(bucketId: string, key: string): string {
  return `${bucketUrl(bucketId)}/objects/${encodeObjectKey(key)}`;
}

function failureOf(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: UNAVAILABLE, code: null };
}

function isSortChoice(value: string): value is SortChoice {
  return value === "key" || value === "size" || value === "time";
}

function prefixSegments(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split("/").filter((part) => part.length > 0);
  const segments: { label: string; prefix: string }[] = [];
  let built = "";
  for (const part of parts) {
    built = `${built}${part}/`;
    segments.push({ label: part, prefix: built });
  }
  return segments;
}

function compareObjects(left: ObjectEntry, right: ObjectEntry, sort: "size" | "time"): number {
  if (sort === "size" && left.size !== right.size) {
    return left.size < right.size ? -1 : 1;
  }
  if (sort === "time" && left.lastModified !== right.lastModified) {
    return left.lastModified < right.lastModified ? -1 : 1;
  }
  if (left.key === right.key) {
    return 0;
  }
  return left.key < right.key ? -1 : 1;
}

// 前缀没有大小和修改时间，按这两列排序时保持在对象前面。
function sortLoaded(entries: Entry[], sort: SortChoice): Entry[] {
  if (sort === "key") {
    return entries;
  }
  const folders: PrefixEntry[] = [];
  const files: ObjectEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "prefix") {
      folders.push(entry);
    } else {
      files.push(entry);
    }
  }
  files.sort((left, right) => compareObjects(left, right, sort));
  return [...folders, ...files];
}

function matchesAsEntries(matches: SearchMatch[]): ObjectEntry[] {
  return matches.map((match) => ({ kind: "object", ...match }));
}

export function Objects({ bucketId, onBack }: { bucketId: string; onBack: () => void }) {
  const [browse, setBrowse] = useState(initialBrowse);
  const [draft, setDraft] = useState("");
  const [kept, setKept] = useState<{ prefix: string; page: ObjectPage } | null>(null);
  const searching = browse.search !== null;
  const list = useQuery({
    queryKey: ["bucket-objects", bucketId, browse.prefix, browse.next],
    queryFn: () => readJson(listPath(bucketId, browse.prefix, browse.next)).then(parsePage),
    enabled: !searching,
  });
  const found = useQuery({
    queryKey: ["bucket-object-search", bucketId, browse.prefix, browse.search],
    queryFn: () =>
      readJson(searchPath(bucketId, browse.prefix, browse.search ?? "")).then(parseSearch),
    enabled: searching,
  });
  const meta = useQuery({
    queryKey: ["bucket-object", bucketId, browse.selected],
    queryFn: () => readJson(metadataPath(bucketId, browse.selected ?? "")).then(parseMeta),
    enabled: browse.selected !== null,
  });
  if (!searching && list.data && (kept === null || kept.page !== list.data)) {
    setKept({ prefix: browse.prefix, page: list.data });
  }

  const page = list.data ?? (kept !== null && kept.prefix === browse.prefix ? kept.page : null);
  const entries = searching ? matchesAsEntries(found.data?.matches ?? []) : (page?.entries ?? []);
  const visible = sortLoaded(entries, browse.sort);
  const loading = searching ? found.isLoading : list.isLoading;
  const listFailure = !searching && list.isError ? failureOf(list.error) : null;
  const searchFailure = searching && found.isError ? failureOf(found.error) : null;
  const metaFailure = browse.selected !== null && meta.isError ? failureOf(meta.error) : null;
  const failure = listFailure ?? searchFailure;
  const showRows = visible.length > 0 && (searching ? found.isSuccess : page !== null);
  const showEmpty = searching
    ? found.isSuccess && found.data !== undefined && found.data.matches.length === 0
    : list.isSuccess && list.data !== undefined && list.data.entries.length === 0;
  const next =
    !searching && page && page.next && page.next !== browse.next && !list.isError ? page.next : null;

  function openPrefix(prefix: string) {
    setDraft("");
    setBrowse((current) => ({
      ...current,
      prefix,
      next: null,
      search: null,
      selected: null,
    }));
  }

  function retry() {
    if (searching) {
      void found.refetch();
    } else {
      void list.refetch();
    }
    if (browse.selected !== null) {
      void meta.refetch();
    }
  }

  return (
    <section className="grid gap-4" aria-label="Objects" aria-busy={loading}>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={onBack}
      >
        Back to buckets
      </button>
      <nav aria-label="Prefix" className="flex flex-wrap gap-2">
        <button
          className="border border-neutral-900 px-2 py-1 text-left"
          type="button"
          onClick={() => {
            openPrefix("");
          }}
        >
          {bucketId}
        </button>
        {prefixSegments(browse.prefix).map((segment) => (
          <button
            key={segment.prefix}
            className="border border-neutral-900 px-2 py-1 text-left"
            type="button"
            onClick={() => {
              openPrefix(segment.prefix);
            }}
          >
            {segment.label}
          </button>
        ))}
      </nav>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const q = draft.trim();
          if (q.length < 2) {
            return;
          }
          setBrowse((current) => ({
            ...current,
            search: q,
            next: null,
            selected: null,
          }));
        }}
      >
        <label className="block text-sm">
          Search
          <input
            className="mt-1 border border-neutral-300 px-2 py-1"
            value={draft}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <button className="border border-neutral-900 px-3 py-1 text-left" type="submit">
          Search
        </button>
      </form>
      <label className="block text-sm">
        Sort
        <select
          className="mt-1 border border-neutral-300 px-2 py-1"
          value={browse.sort}
          onChange={(event) => {
            const value = event.target.value;
            if (!isSortChoice(value)) {
              return;
            }
            setBrowse((current) => ({ ...current, sort: value }));
          }}
        >
          <option value="key">Key</option>
          <option value="size">Size</option>
          <option value="time">Time</option>
        </select>
      </label>
      {browse.sort !== "key" ? <p>Only this page</p> : null}
      {loading ? <p>Loading objects</p> : null}
      {failure ? <p>{failure.message}</p> : null}
      {failure?.code ? <p>{failure.code}</p> : null}
      {metaFailure ? <p>{metaFailure.message}</p> : null}
      {metaFailure?.code ? <p>{metaFailure.code}</p> : null}
      {failure || metaFailure ? (
        <button
          className="border border-neutral-900 px-3 py-1 text-left"
          type="button"
          onClick={retry}
        >
          Retry
        </button>
      ) : null}
      {showEmpty ? <p>There are no objects.</p> : null}
      {searching && found.data?.truncated && found.data.reason ? <p>{found.data.reason}</p> : null}
      {showRows && visible.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Key
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Size
                </th>
                <th className="py-2 font-medium" scope="col">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) =>
                entry.kind === "prefix" ? (
                  <tr key={`prefix:${entry.prefix}`}>
                    <td className="py-2 pr-3">
                      <button
                        className="border border-neutral-900 px-2 py-1 text-left"
                        type="button"
                        onClick={() => {
                          openPrefix(entry.prefix);
                        }}
                      >
                        {entry.prefix}
                      </button>
                    </td>
                    <td />
                    <td />
                  </tr>
                ) : (
                  <tr key={`object:${entry.key}`}>
                    <td className="py-2 pr-3">
                      <button
                        className="border border-neutral-900 px-2 py-1 text-left"
                        type="button"
                        onClick={() => {
                          setBrowse((current) => ({ ...current, selected: entry.key }));
                        }}
                      >
                        {entry.key}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{entry.size}</td>
                    <td className="py-2">{entry.lastModified}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {meta.data && browse.selected === meta.data.key ? <p>{meta.data.contentType}</p> : null}
      {next ? (
        <button
          className="border border-neutral-900 px-3 py-1 text-left"
          type="button"
          onClick={() => {
            setBrowse((current) => ({ ...current, next, selected: null }));
          }}
        >
          Next page
        </button>
      ) : null}
    </section>
  );
}
