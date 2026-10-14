import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { encodeObjectKey } from "./App";
import { InstantText, copy, fill, translate } from "./i18n";
import { ApiError, api, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { bucketUrl } from "./BucketPermissions";
import { ConfirmDialog } from "./confirm";
import { bucketLocationFromHash, hashForObjects, useLocationHash } from "./Nav";
import { releaseHash } from "./unsaved";
import { Pagination } from "./ui";
import { UploadPanel } from "./UploadPanel";

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

const INSPECT_FLAGS = ["encrypted", "uploading", "aborted", "deleteMarker", "inline"] as const;

type InspectFlag = (typeof INSPECT_FLAGS)[number];

type InspectVersion = {
  uuid: string;
} & Record<InspectFlag, boolean>;

type InspectedObject = {
  bucketId: string;
  key: string;
  versions: InspectVersion[];
};

type SortChoice = "key" | "size" | "time";

type BrowseState = {
  next: string | null;
  sort: SortChoice;
  search: string | null;
  selected: string | null;
  picked: string[];
  anchor: string | null;
};

type Failure = {
  message: string;
  code: string | null;
};

type PendingDelete =
  | { kind: "object"; name: string }
  | { kind: "prefix"; name: string }
  | { kind: "batch"; keys: string[]; totalSize: number };

type DeleteFailure = {
  key: string;
  message: string;
};

const PAGE_LIMIT = "100";
function unavailableMessage(): string {
  return copy("ui.objects.are.unavailable");
}
const SHARE_TIERS = [
  { label: "Share for 1 hour", seconds: 3600 },
  { label: "Share for 24 hours", seconds: 86400 },
  { label: "Share for 7 days", seconds: 604800 },
] as const;

const initialBrowse: BrowseState = {
  next: null,
  sort: "key",
  search: null,
  selected: null,
  picked: [],
  anchor: null,
};

const wrap = "min-w-0 max-w-full break-all";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(unavailableMessage());
  }
  return value;
}

function requiredBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new Error(unavailableMessage());
  }
  return value;
}

function requiredSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(unavailableMessage());
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
    throw new Error(unavailableMessage());
  }
  if (value.kind === "prefix") {
    return { kind: "prefix", prefix: requiredString(value, "prefix") };
  }
  if (value.kind === "object") {
    return parseObject(value);
  }
  throw new Error(unavailableMessage());
}

function parseNext(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(unavailableMessage());
  }
  return value;
}

function parsePage(value: unknown): ObjectPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error(unavailableMessage());
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
  throw new Error(unavailableMessage());
}

function parseSearch(value: unknown): SearchPage {
  if (!isRecord(value) || !Array.isArray(value.matches) || typeof value.truncated !== "boolean") {
    throw new Error(unavailableMessage());
  }
  return {
    matches: value.matches.map((match) => {
      if (!isRecord(match)) {
        throw new Error(unavailableMessage());
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
    throw new Error(unavailableMessage());
  }
  return {
    key: requiredString(value, "key"),
    size: requiredSize(value.size),
    etag: requiredString(value, "etag"),
    lastModified: requiredString(value, "lastModified"),
    contentType: requiredString(value, "contentType"),
  };
}

function parseInspectVersion(value: unknown): InspectVersion {
  if (!isRecord(value)) {
    throw new Error(unavailableMessage());
  }
  return {
    uuid: requiredString(value, "uuid"),
    encrypted: requiredBoolean(value, "encrypted"),
    uploading: requiredBoolean(value, "uploading"),
    aborted: requiredBoolean(value, "aborted"),
    deleteMarker: requiredBoolean(value, "deleteMarker"),
    inline: requiredBoolean(value, "inline"),
  };
}

function parseInspect(value: unknown): InspectedObject {
  if (!isRecord(value) || !Array.isArray(value.versions)) {
    throw new Error(unavailableMessage());
  }
  return {
    bucketId: requiredString(value, "bucketId"),
    key: requiredString(value, "key"),
    versions: value.versions.map(parseInspectVersion),
  };
}

function yesNo(value: boolean): string {
  return value ? copy("ui.yes") : copy("ui.no");
}

function parseBatchDelete(value: unknown): DeleteFailure[] {
  if (!isRecord(value) || !Array.isArray(value.failed)) {
    throw new Error(unavailableMessage());
  }
  return value.failed.map((item) => {
    if (!isRecord(item)) {
      throw new Error(unavailableMessage());
    }
    return {
      key: requiredString(item, "key"),
      message: requiredString(item, "message"),
    };
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await api<unknown>(path);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new Error(unavailableMessage());
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

const BITMAP_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

function bitmapKey(key: string): boolean {
  const slash = key.lastIndexOf("/");
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return false;
  }
  return BITMAP_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function thumbnailPath(bucketId: string, key: string): string {
  return `${metadataPath(bucketId, key)}?thumbnail=1`;
}

function ObjectThumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10 shrink-0 border border-line">
        <rect x="3" y="4" width="18" height="16" fill="none" stroke="currentColor" />
        <path d="M3 16l5-4 3 2 4-5 6 7" fill="none" stroke="currentColor" />
      </svg>
    );
  }
  return (
    <img
      alt=""
      className="h-10 w-10 shrink-0 border border-line object-contain"
      src={src}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function inspectPath(bucketId: string, key: string): string {
  return `${bucketUrl(bucketId)}/inspect/${encodeObjectKey(key)}`;
}

function archiveHref(bucketId: string, value: unknown): string {
  if (!isRecord(value)) {
    throw new Error(unavailableMessage());
  }
  const token = requiredString(value, "token");
  return `${bucketUrl(bucketId)}/archive?token=${encodeURIComponent(token)}`;
}

function previewPath(bucketId: string, key: string): string {
  return `${metadataPath(bucketId, key)}?preview=1`;
}

type InlineKind = "image" | "text" | "pdf" | "video" | "audio";

const INLINE_KIND: Record<string, InlineKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "image/bmp": "image",
  "image/x-icon": "image",
  "image/vnd.microsoft.icon": "image",
  "text/plain": "text",
  "application/pdf": "pdf",
  "video/mp4": "video",
  "video/webm": "video",
  "audio/mpeg": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
};

function inlineKind(contentType: string): InlineKind | null {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return INLINE_KIND[mime] ?? null;
}

function codeOf(text: string): string | null {
  if (!text.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const code = (parsed as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

type TextPreview = {
  body: string;
  partial: boolean;
};

async function readPreviewText(path: string, signal: AbortSignal): Promise<TextPreview> {
  // api() parses the response as JSON, so a plain-text preview has to read the body itself.
  const response = await fetch(path, {
    credentials: "include",
    headers: { Range: "bytes=0-262143" },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    noteUnauthenticated(response.status, codeOf(text));
    throw new Error(unavailableMessage());
  }
  return {
    body: await response.text(),
    partial: response.status === 206,
  };
}

function InlineBody({
  kind,
  objectKey,
  src,
  text,
}: {
  kind: InlineKind;
  objectKey: string;
  src: string;
  text: TextPreview | undefined;
}) {
  switch (kind) {
    case "image":
      return <img alt={objectKey} src={src} />;
    case "text":
      return text === undefined ? null : (
        <>
          <pre>{text.body}</pre>
          {text.partial ? <p>{copy("ui.showing.the.first.256.kib")}</p> : null}
        </>
      );
    case "pdf":
      // Allow scripts only, and do not grant same origin, so a PDF script cannot reach the console.
      return <iframe sandbox="allow-scripts" src={src} title={objectKey} />;
    case "video":
      return <video controls src={src} />;
    case "audio":
      return <audio controls src={src} />;
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function parseCanShare(value: unknown): boolean {
  return isRecord(value) && value.can_share === true;
}

function parseKeyIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(unavailableMessage());
  }
  return value.items.map((item) => {
    if (!isRecord(item)) {
      throw new Error(unavailableMessage());
    }
    return requiredString(item, "id");
  });
}

function parseShare(
  key: string,
  value: unknown,
): { key: string; url: string; website: string | null } {
  if (!isRecord(value)) {
    throw new Error(unavailableMessage());
  }
  const website = value.website_url;
  return {
    key,
    url: requiredString(value, "url"),
    website: typeof website === "string" && website.length > 0 ? website : null,
  };
}

function failureOf(error: unknown): Failure {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: unavailableMessage(), code: null };
}

function isSortChoice(value: string): value is SortChoice {
  return value === "key" || value === "size" || value === "time";
}

function sortFromAddress(value: string | null): SortChoice {
  if (value === "size" || value === "time") {
    return value;
  }
  return "key";
}

function readObjectQuery(): { filter: string; sort: SortChoice } {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: params.get("objects") ?? "",
    sort: sortFromAddress(params.get("objectsSort")),
  };
}

function writeObjectQuery(filter: string, sort: SortChoice) {
  const params = new URLSearchParams(window.location.search);
  if (filter.length > 0) {
    params.set("objects", filter);
  } else {
    params.delete("objects");
  }
  if (sort === "key") {
    params.delete("objectsSort");
  } else {
    params.set("objectsSort", sort);
  }
  const search = params.toString();
  const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
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

// A prefix has no size or modification time, so those sorts keep it ahead of the objects.
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

function objectKeys(entries: readonly Entry[]): string[] {
  const keys: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "object") {
      keys.push(entry.key);
    }
  }
  return keys;
}

function neighborObject(keys: readonly string[], current: string, direction: -1 | 1): string {
  const index = keys.indexOf(current);
  if (index < 0) {
    return current;
  }
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= keys.length) {
    return current;
  }
  return keys[nextIndex];
}

function arrowMovesSelection(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return target.type === "checkbox";
  }
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLMediaElement
  ) {
    return false;
  }
  if (target instanceof Element && target.closest("dialog") !== null) {
    return false;
  }
  return true;
}

function batchSelection(
  entries: readonly Entry[],
  picked: readonly string[],
): { keys: string[]; totalSize: number } {
  const chosen = new Set(picked);
  const keys: string[] = [];
  let totalSize = 0;
  for (const entry of entries) {
    if (entry.kind !== "object" || !chosen.has(entry.key)) {
      continue;
    }
    keys.push(entry.key);
    totalSize += entry.size;
  }
  return { keys, totalSize };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

// Bulk selection keeps only object keys visible on this page. After a page change, keys from the previous page leave the bar.
function pickedOnPage(picked: readonly string[], visibleKeys: readonly string[]): string[] {
  const visible = new Set(visibleKeys);
  return picked.filter((key) => visible.has(key));
}

function toggleKey(picked: readonly string[], key: string): string[] {
  return picked.includes(key) ? picked.filter((item) => item !== key) : [...picked, key];
}

function rangeKeys(visibleKeys: readonly string[], anchor: string | null, key: string): string[] {
  const end = visibleKeys.indexOf(key);
  if (end < 0) {
    return [];
  }
  const start = anchor === null ? end : visibleKeys.indexOf(anchor);
  if (start < 0) {
    return [visibleKeys[end]];
  }
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return visibleKeys.slice(from, to + 1);
}

async function copyText(value: string): Promise<"copied" | "manual"> {
  const clipboard = navigator.clipboard;
  if (!window.isSecureContext || typeof clipboard?.writeText !== "function") {
    return "manual";
  }
  try {
    await clipboard.writeText(value);
    return "copied";
  } catch {
    return "manual";
  }
}

export function Objects({
  bucketId,
  onBack,
  canWrite,
  canTransfer,
  canManage = false,
}: {
  bucketId: string;
  onBack: () => void;
  canWrite: boolean;
  canTransfer: boolean;
  canManage?: boolean;
}) {
  const client = useQueryClient();
  const [hash, assignHash] = useLocationHash();
  const location = bucketLocationFromHash(hash);
  const prefix =
    location.kind === "objects" && location.bucketId === bucketId ? location.prefix : "";
  const [browse, setBrowse] = useState<BrowseState>(() => {
    const address = readObjectQuery();
    return {
      ...initialBrowse,
      sort: address.sort,
      search: address.filter.length >= 2 ? address.filter : null,
    };
  });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [activeUploads, setActiveUploads] = useState(0);
  const [draft, setDraft] = useState(() => readObjectQuery().filter);
  const [trackedPrefix, setTrackedPrefix] = useState(prefix);
  const [kept, setKept] = useState<{ prefix: string; page: ObjectPage } | null>(null);
  const [copyNote, setCopyNote] = useState<"copied" | "manual" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [keyChoice, setKeyChoice] = useState("");
  const [shareLink, setShareLink] = useState<{
    key: string;
    url: string;
    website: string | null;
  } | null>(null);
  const [zipLink, setZipLink] = useState<{ keys: readonly string[]; href: string } | null>(null);
  const [inspectKey, setInspectKey] = useState<string | null>(null);
  const zipAnchor = useRef<HTMLAnchorElement>(null);
  const stepRef = useRef<{ previewKey: string | null; visibleKeys: readonly string[] }>({
    previewKey: null,
    visibleKeys: [],
  });
  let pageToken = browse.next;
  let search = browse.search;
  let selected = browse.selected;
  let picked = browse.picked;
  let inspected = inspectKey;
  const prefixChanged = trackedPrefix !== prefix;
  if (prefixChanged) {
    inspected = null;
    pageToken = null;
    search = null;
    selected = null;
    picked = [];
    setTrackedPrefix(prefix);
    setCursors([null]);
    setPageIndex(0);
    setDraft("");
    writeObjectQuery("", browse.sort);
    setBrowse((current) => ({
      ...current,
      next: null,
      search: null,
      selected: null,
      picked: [],
      anchor: null,
    }));
    if (copyNote !== null) {
      setCopyNote(null);
    }
    if (pendingDelete !== null) {
      setPendingDelete(null);
    }
    if (shareLink !== null) {
      setShareLink(null);
    }
    if (zipLink !== null) {
      setZipLink(null);
    }
    if (inspectKey !== null) {
      setInspectKey(null);
    }
  }
  const searching = search !== null;
  // Read the share flag on the object page. The caller does not have this field, so this file cannot change the parent to pass it down.
  const session = useQuery({
    queryKey: ["auth-status"],
    queryFn: async () => {
      try {
        return parseCanShare(await readJson("/api/auth/status"));
      } catch {
        return false;
      }
    },
  });
  const canShare = session.data === true;
  const list = useQuery({
    queryKey: ["bucket-objects", bucketId, prefix, pageToken],
    queryFn: () => readJson(listPath(bucketId, prefix, pageToken)).then(parsePage),
    enabled: !searching,
  });
  const found = useQuery({
    queryKey: ["bucket-object-search", bucketId, prefix, search],
    queryFn: () => readJson(searchPath(bucketId, prefix, search ?? "")).then(parseSearch),
    enabled: searching,
  });
  const listBusy = searching ? found.isFetching : list.isFetching;
  const inspect = useQuery({
    queryKey: ["bucket-object-inspect", bucketId, inspected],
    queryFn: () => readJson(inspectPath(bucketId, inspected ?? "")).then(parseInspect),
    enabled: inspected !== null && !listBusy,
  });
  const meta = useQuery({
    queryKey: ["bucket-object", bucketId, selected],
    queryFn: () => readJson(metadataPath(bucketId, selected ?? "")).then(parseMeta),
    enabled: selected !== null,
  });
  const removeObject = useMutation({
    mutationFn: async (key: string) => {
      await api(
        `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeObjectKey(key)}`,
        { method: "DELETE" },
      );
    },
    onSuccess: async () => {
      setPendingDelete(null);
      setCopyNote(null);
      setBrowse((current) => ({ ...current, picked: [], anchor: null }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bucket-objects", bucketId] }),
        client.invalidateQueries({ queryKey: ["bucket-object-search", bucketId] }),
      ]);
    },
  });
  const removePrefix = useMutation({
    mutationFn: async (prefix: string) => {
      await api(
        `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeObjectKey(prefix)}?recursive=true`,
        { method: "DELETE" },
      );
    },
    onSuccess: async () => {
      setPendingDelete(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bucket-objects", bucketId] }),
        client.invalidateQueries({ queryKey: ["bucket-object-search", bucketId] }),
      ]);
    },
  });
  const removeMany = useMutation({
    mutationFn: async (keys: readonly string[]) => {
      const body = await api<unknown>(
        `/api/buckets/${encodeURIComponent(bucketId)}/objects:delete`,
        { method: "POST", body: JSON.stringify({ keys }) },
      );
      const failed = parseBatchDelete(body);
      // A batch may delete some keys even when another key fails.
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bucket-objects", bucketId] }),
        client.invalidateQueries({ queryKey: ["bucket-object-search", bucketId] }),
      ]);
      if (failed.length > 0) {
        throw new Error(failed.map((item) => `${item.key}: ${item.message}`).join(" "));
      }
    },
    onSuccess: async () => {
      setPendingDelete(null);
      setCopyNote(null);
      setBrowse((current) => ({ ...current, picked: [], anchor: null }));
    },
  });
  const archiveZip = useMutation({
    mutationFn: async (keys: readonly string[]) => {
      const body = await api<unknown>(`${bucketUrl(bucketId)}/archive-token`, {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      return archiveHref(bucketId, body);
    },
  });
  if (!searching && list.data && (kept === null || kept.page !== list.data)) {
    setKept({ prefix, page: list.data });
  }

  const page = list.data ?? (kept !== null && kept.prefix === prefix ? kept.page : null);
  const entries = searching ? matchesAsEntries(found.data?.matches ?? []) : (page?.entries ?? []);
  const visible = sortLoaded(entries, browse.sort);
  const visibleKeys = objectKeys(visible);
  const shownPicked = pickedOnPage(picked, visibleKeys);
  const pathText = visibleKeys.filter((key) => shownPicked.includes(key)).join("\n");
  const archiveKeys = batchSelection(visible, shownPicked).keys;
  const zipHref = zipLink !== null && sameKeys(zipLink.keys, archiveKeys) ? zipLink.href : null;
  const singleKey = shownPicked.length === 1 ? shownPicked[0] : null;
  const previewKey = canTransfer ? singleKey : null;
  stepRef.current = { previewKey, visibleKeys };
  const shareObject = useMutation({
    mutationFn: async (ttl: number) => {
      const key = singleKey;
      if (key === null) {
        throw new Error(copy("ui.select.one.object"));
      }
      const body = await api<unknown>("/api/share", {
        method: "POST",
        body: JSON.stringify({ ttl_seconds: ttl, bucket: bucketId, key }),
      });
      return parseShare(key, body);
    },
    onSuccess: (link) => {
      setShareLink(link);
    },
  });
  const chooseKey = useMutation({
    mutationFn: async (accessKeyId: string) => {
      await api(`${bucketUrl(bucketId)}/credential`, {
        method: "PUT",
        body: JSON.stringify({ access_key_id: accessKeyId }),
      });
    },
    onSuccess: async () => {
      setKeyChoice("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bucket-objects", bucketId] }),
        client.invalidateQueries({ queryKey: ["bucket-object-search", bucketId] }),
      ]);
    },
  });
  const previewMeta = useQuery({
    queryKey: ["bucket-object", bucketId, previewKey],
    queryFn: () => readJson(metadataPath(bucketId, previewKey ?? "")).then(parseMeta),
    enabled: previewKey !== null,
  });
  const preview =
    previewKey !== null && previewMeta.data && previewMeta.data.key === previewKey
      ? previewMeta.data
      : null;
  const kind = preview === null ? null : inlineKind(preview.contentType);
  const previewText = useQuery({
    queryKey: ["bucket-object-text", bucketId, previewKey],
    queryFn: ({ signal }) => readPreviewText(previewPath(bucketId, previewKey ?? ""), signal),
    enabled: previewKey !== null && kind === "text",
  });
  const deleteError = removeObject.error instanceof Error ? removeObject.error.message : null;
  const prefixError = removePrefix.error instanceof Error ? removePrefix.error.message : null;
  const batchError = removeMany.error instanceof Error ? removeMany.error.message : null;
  const loading = searching ? found.isLoading : list.isLoading;
  const listFailure = !searching && list.isError ? failureOf(list.error) : null;
  const searchFailure = searching && found.isError ? failureOf(found.error) : null;
  const metaFailure = selected !== null && meta.isError ? failureOf(meta.error) : null;
  const failure = listFailure ?? searchFailure;
  const needsKey = canWrite && listFailure?.code === "no_usable_key";
  const keyChoices = useQuery({
    queryKey: ["access-keys", bucketId],
    queryFn: () => readJson("/api/keys?limit=100").then(parseKeyIds),
    enabled: needsKey,
  });
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const current = stepRef.current;
      if (current.previewKey === null || !arrowMovesSelection(event.target)) {
        return;
      }
      const next = neighborObject(
        current.visibleKeys,
        current.previewKey,
        event.key === "ArrowLeft" ? -1 : 1,
      );
      event.preventDefault();
      if (next === current.previewKey) {
        return;
      }
      setCopyNote(null);
      setBrowse((state) => ({
        ...state,
        picked: [next],
        anchor: next,
      }));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const showFailure = failure !== null && !isGarageDown(failure);
  const showMeta = metaFailure !== null && !isGarageDown(metaFailure);
  const showRows = visible.length > 0 && (searching ? found.isSuccess : page !== null);
  const showEmpty = searching
    ? found.isSuccess && found.data !== undefined && found.data.matches.length === 0
    : list.isSuccess && list.data !== undefined && list.data.entries.length === 0;
  const nextPage =
    !searching && page && page.next && page.next !== pageToken && !list.isError ? page.next : null;

  function openPrefix(nextPrefix: string) {
    const destination = hashForObjects(bucketId, nextPrefix);
    if (!releaseHash(destination)) return;
    setCursors([null]);
    setPageIndex(0);
    setDraft("");
    setCopyNote(null);
    setBrowse((current) => ({
      ...current,
      next: null,
      search: null,
      selected: null,
      picked: [],
      anchor: null,
    }));
    assignHash(destination);
  }

  function pick(key: string, shift: boolean) {
    setCopyNote(null);
    setBrowse((current) => ({
      ...current,
      picked: shift
        ? rangeKeys(visibleKeys, current.anchor, key)
        : toggleKey(pickedOnPage(current.picked, visibleKeys), key),
      anchor: key,
    }));
  }

  function selectPage() {
    setCopyNote(null);
    setBrowse((current) => ({
      ...current,
      picked: visibleKeys,
      anchor: visibleKeys.length > 0 ? visibleKeys[visibleKeys.length - 1] : null,
    }));
  }

  function copyPaths() {
    void copyText(pathText).then((result) => {
      setCopyNote(result);
    });
  }

  function retry() {
    if (searching) {
      void found.refetch();
    } else {
      void list.refetch();
    }
    if (selected !== null) {
      void meta.refetch();
    }
  }

  return (
    <section className="ui-page" aria-label={copy("nav.objects")} aria-busy={loading}>
      <header className="ui-page-header">
      <h2>{copy("nav.objects")}</h2>
      <button
        className="ui-button"
        type="button"
        onClick={onBack}
      >
        {copy("ui.back.to.buckets")}</button>
      </header>
      <nav aria-label={copy("ui.prefix")} className="ui-actions">
        <button
          className={`${wrap} ui-button ui-identifier whitespace-normal text-left`}
          type="button"
          onClick={() => {
            openPrefix("");
          }}
        >
          {bucketId}
        </button>
        {prefixSegments(prefix).map((segment) => (
          <button
            key={segment.prefix}
            className={`${wrap} ui-button ui-identifier whitespace-normal text-left`}
            type="button"
            onClick={() => {
              openPrefix(segment.prefix);
            }}
          >
            {segment.label}
          </button>
        ))}
      </nav>
      <div className="ui-toolbar items-end">
      <form
        className="ui-actions items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const q = draft.trim();
          if (q.length < 2) {
            return;
          }
          setCursors([null]);
          setPageIndex(0);
          setBrowse((current) => ({
            ...current,
            search: q,
            next: null,
            selected: null,
          }));
          writeObjectQuery(q, browse.sort);
        }}
      >
        <label className="ui-field">
          {copy("ui.search")}<input
            className="ui-input"
            value={draft}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <button className="ui-button" type="submit">
          {copy("ui.search")}</button>
      </form>
      <label className="ui-field">
        {copy("ui.sort")}<select
          className="ui-input"
          value={browse.sort}
          onChange={(event) => {
            const value = event.target.value;
            if (!isSortChoice(value)) {
              return;
            }
            setBrowse((current) => ({ ...current, sort: value }));
            writeObjectQuery(browse.search ?? "", value);
          }}
        >
          <option value="key">{copy("ui.key.2")}</option>
          <option value="size">{copy("ui.size")}</option>
          <option value="time">{copy("ui.time")}</option>
        </select>
      </label>
      </div>
      {browse.sort !== "key" ? <p>{copy("ui.only.this.page")}</p> : null}
      {canWrite ? (
        <details className="ui-disclosure">
          <summary>
            {copy("ui.upload")}
            {activeUploads > 0 ? <span className="ui-status ml-3">{copy("ui.uploading")} · {activeUploads}</span> : null}
          </summary>
          <UploadPanel key={bucketId} bucketId={bucketId} existingKeys={visibleKeys} onActiveChange={setActiveUploads} />
        </details>
      ) : null}
      {loading && !showRows ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.objects")}>{copy("ui.loading.objects")}</div>
      ) : null}
      {showFailure && failure ? <p className="ui-alert">{failure.message}</p> : null}
      {showFailure && failure?.code ? <p>{failure.code}</p> : null}
      {needsKey ? (
        <form
          className="ui-panel ui-actions items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (keyChoice.length === 0 || chooseKey.isPending) {
              return;
            }
            chooseKey.mutate(keyChoice);
          }}
        >
          <label className="ui-field">
            {copy("ui.bucket.key")}<select
              className="ui-input"
              value={keyChoice}
              onChange={(event) => {
                setKeyChoice(event.target.value);
              }}
            >
              <option value="">{copy("ui.select.a.key")}</option>
              {(keyChoices.data ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ui-button"
            type="submit"
            disabled={keyChoice.length === 0 || chooseKey.isPending}
          >
            {copy("ui.use.this.key")}</button>
          {keyChoices.isError ? <p>{failureOf(keyChoices.error).message}</p> : null}
          {chooseKey.error instanceof Error ? <p>{chooseKey.error.message}</p> : null}
        </form>
      ) : null}
      {showMeta && metaFailure ? <p>{metaFailure.message}</p> : null}
      {showMeta && metaFailure?.code ? <p>{metaFailure.code}</p> : null}
      {showFailure || showMeta ? (
        <button
          className="ui-button"
          type="button"
          onClick={retry}
        >
          {copy("ui.retry")}</button>
      ) : null}
      {showEmpty ? (
        <p>
          {!searching && canWrite
            ? copy("ui.there.are.no.objects.upload.the.first.object")
            : copy("ui.there.are.no.objects")}
        </p>
      ) : null}
      {searching && found.data?.truncated && found.data.reason ? <p>{found.data.reason}</p> : null}
      {shownPicked.length > 0 ? (
        <div className="ui-panel ui-actions">
          <span className="ui-status">{fill(copy("ui.objects"), { used: shownPicked.length })}</span>
          <button
            className="ui-button"
            type="button"
            onClick={copyPaths}
          >
            {copy("ui.copy.path")}</button>
          {canWrite ? (
            <button
              className="ui-button"
              type="button"
              onClick={() => {
                // One key still uses DELETE. Two or more keys POST objects:delete. One click must not call the batch route.
                if (shownPicked.length === 1) {
                  removeObject.reset();
                  setPendingDelete({ kind: "object", name: shownPicked[0] });
                  return;
                }
                const batch = batchSelection(visible, shownPicked);
                removeMany.reset();
                setPendingDelete({ kind: "batch", keys: batch.keys, totalSize: batch.totalSize });
              }}
            >
              {copy("ui.delete.2")}</button>
          ) : null}
          {canTransfer && shownPicked.length > 1 ? (
            <>
              <button
                className="ui-button"
                type="button"
                disabled={archiveZip.isPending}
                onClick={() => {
                  archiveZip.mutate(archiveKeys, {
                    onSuccess: (href) => {
                      setZipLink({ keys: archiveKeys, href });
                      const anchor = zipAnchor.current;
                      if (anchor === null) {
                        return;
                      }
                      anchor.href = href;
                      anchor.click();
                    },
                  });
                }}
              >
                {copy("ui.download.zip")}</button>
              <a ref={zipAnchor} href={zipHref ?? undefined} target="_blank" rel="noopener" hidden />
              {archiveZip.error instanceof Error ? <p>{archiveZip.error.message}</p> : null}
            </>
          ) : null}
          {canTransfer && singleKey !== null ? (
            <a
              className="ui-button"
              href={`${metadataPath(bucketId, singleKey)}?download=1`}
              target="_blank"
              rel="noopener"
            >
              {copy("ui.download")}</a>
          ) : null}
          {canShare && singleKey !== null
            ? SHARE_TIERS.map((tier) => (
                <button
                  key={tier.seconds}
                  className="ui-button"
                  type="button"
                  onClick={() => {
                    shareObject.reset();
                    shareObject.mutate(tier.seconds);
                  }}
                >
                  {translate(tier.label)}
                </button>
              ))
            : null}
          {shareLink !== null && shareLink.key === singleKey ? (
            <>
              <p>{shareLink.url}</p>
              {shareLink.website !== null ? <p>{shareLink.website}</p> : null}
            </>
          ) : null}
          {shareObject.error instanceof Error ? <p>{shareObject.error.message}</p> : null}
          {copyNote === "copied" ? <p>{copy("ui.copied")}</p> : null}
          {copyNote === "manual" ? (
            <>
              <p>{copy("ui.select.the.paths.and.copy.them")}</p>
              <textarea
                className="ui-input"
                readOnly
                aria-label={copy("ui.selected.paths")}
                value={pathText}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {showRows && visible.length > 0 ? (
        <div className="ui-table-container" role="region" aria-label={copy("nav.objects")} tabIndex={0}>
          <table className="ui-table">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  <button
                    className="ui-button"
                    type="button"
                    onClick={selectPage}
                  >
                    {copy("ui.select.page")}</button>
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.key.2")}</th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.size")}</th>
                <th className="py-2 font-medium" scope="col">
                  {copy("ui.time")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) =>
                entry.kind === "prefix" ? (
                  <tr key={`prefix:${entry.prefix}`}>
                    <td />
                    <td className="min-w-0 max-w-full break-all">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className={`${wrap} ui-button ui-identifier whitespace-normal text-left`}
                          type="button"
                          onClick={() => {
                            openPrefix(entry.prefix);
                          }}
                        >
                          {entry.prefix}
                        </button>
                        {canWrite ? (
                          <button
                            className="ui-button"
                            type="button"
                            onClick={() => {
                              removePrefix.reset();
                              setPendingDelete({ kind: "prefix", name: entry.prefix });
                            }}
                          >
                            {copy("ui.delete.folder")}</button>
                        ) : null}
                      </div>
                    </td>
                    <td />
                    <td />
                  </tr>
                ) : (
                  <tr key={`object:${entry.key}`}>
                    <td className="py-2 pr-3">
                      <input
                        aria-label={fill(copy("ui.select"), { key: entry.key })}
                        type="checkbox"
                        checked={shownPicked.includes(entry.key)}
                        onChange={(event) => {
                          const shift =
                            event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey;
                          pick(entry.key, shift);
                        }}
                      />
                    </td>
                    <td className="min-w-0 max-w-full break-all">
                      <div className="flex flex-wrap items-center gap-2">
                        {canTransfer && bitmapKey(entry.key) ? (
                          <ObjectThumb src={thumbnailPath(bucketId, entry.key)} />
                        ) : null}
                        <button
                          className={`${wrap} ui-button ui-identifier whitespace-normal text-left`}
                          type="button"
                          onClick={() => {
                            setBrowse((current) => ({ ...current, selected: entry.key }));
                          }}
                        >
                          {entry.key}
                        </button>
                        {canManage ? (
                          <button
                            className="ui-button"
                            aria-label={fill(copy("ui.inspect"), { key: entry.key })}
                            type="button"
                            onClick={() => {
                              setInspectKey(entry.key);
                            }}
                          >
                            {copy("ui.object.details")}</button>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2 pr-3">{entry.size}</td>
                    <td className="py-2">
                      <InstantText value={entry.lastModified} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      {!searching && showRows ? (
        <Pagination
          page={pageIndex + 1}
          hasPrevious={pageIndex > 0}
          hasNext={nextPage !== null}
          pending={listBusy}
          onPrevious={() => {
            const previous = Math.max(0, pageIndex - 1);
            setPageIndex(previous);
            setBrowse((current) => ({ ...current, next: cursors[previous], selected: null }));
          }}
          onNext={() => {
            if (nextPage === null) return;
            setCursors((current) => [...current.slice(0, pageIndex + 1), nextPage]);
            setPageIndex(pageIndex + 1);
            setBrowse((current) => ({ ...current, next: nextPage, selected: null }));
          }}
        />
      ) : null}
      {preview ? (
        <section className="ui-panel" aria-label={copy("ui.object.details")}>
          <h3 className="ui-identifier">{preview.key}</h3>
          <p>{fill(copy("ui.size.2"), { size: preview.size })}</p>
          <p>{fill(copy("ui.content.type"), { contentType: preview.contentType })}</p>
          <p>{fill(copy("ui.etag"), { etag: preview.etag })}</p>
          <p>
            {copy("ui.last.modified")} <InstantText value={preview.lastModified} />
          </p>
          {kind !== null ? (
            <InlineBody
              kind={kind}
              objectKey={preview.key}
              src={previewPath(bucketId, preview.key)}
              text={previewText.data}
            />
          ) : null}
        </section>
      ) : null}
      {inspect.data && inspected !== null && inspect.data.key === inspected ? (
        <section className="ui-panel" aria-label={fill(copy("ui.inspect.2"), { inspected: inspected })}>
          <h3 className="ui-identifier">{inspected}</h3>
          {inspect.data.versions.map((version) => (
            <div key={version.uuid}>
              <p className="ui-identifier">{version.uuid}</p>
              {INSPECT_FLAGS.map((flag) => (
                <p key={flag}>
                  {flag} {yesNo(version[flag])}
                </p>
              ))}
            </div>
          ))}
        </section>
      ) : null}
      {meta.data && selected === meta.data.key ? <p>{meta.data.contentType}</p> : null}
      {pendingDelete?.kind === "object" ? (
        <ConfirmDialog
          action="delete-object"
          name={pendingDelete.name}
          pending={removeObject.isPending}
          consequence={fill(copy("ui.this.permanently.deletes"), { name: pendingDelete.name, error: deleteError ? ` ${deleteError}` : "" })}
          onCancel={() => {
            setPendingDelete(null);
            removeObject.reset();
          }}
          onConfirm={() => {
            if (removeObject.isPending) {
              return;
            }
            removeObject.mutate(pendingDelete.name);
          }}
        />
      ) : null}
      {pendingDelete?.kind === "batch" ? (
        <ConfirmDialog
          action="batch-delete"
          name={String(pendingDelete.keys.length)}
          pending={removeMany.isPending}
          scope={fill(copy("ui.deletes.objects.bytes"), { length: pendingDelete.keys.length, totalSize: pendingDelete.totalSize })}
          consequence={fill(copy("ui.this.permanently.deletes.objects"), { length: pendingDelete.keys.length, error: batchError ? ` ${batchError}` : "" })}
          onCancel={() => {
            setPendingDelete(null);
            removeMany.reset();
          }}
          onConfirm={() => {
            if (removeMany.isPending) {
              return;
            }
            removeMany.mutate(pendingDelete.keys);
          }}
        />
      ) : null}
      {pendingDelete?.kind === "prefix" ? (
        <ConfirmDialog
          action="recursive-delete"
          name={pendingDelete.name}
          pending={removePrefix.isPending}
          scope={copy("ui.this.deletes.every.object.under.this.prefix")}
          consequence={fill(copy("ui.this.permanently.deletes.every.object.whose.key.starts"), { name: pendingDelete.name, error: prefixError ? ` ${prefixError}` : "" })}
          onCancel={() => {
            setPendingDelete(null);
            removePrefix.reset();
          }}
          onConfirm={() => {
            if (removePrefix.isPending) {
              return;
            }
            removePrefix.mutate(pendingDelete.name);
          }}
        />
      ) : null}
    </section>
  );
}
