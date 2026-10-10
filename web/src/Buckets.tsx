import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { BucketPermissions, bucketUrl } from "./BucketPermissions";
import { bucketLocationFromHash, hashForObjects, useLocationHash } from "./Nav";
import { Objects } from "./Objects";

type Alias =
  | { scope: "global"; name: string }
  | { scope: "local"; name: string; accessKeyId: string | null };

type AliasBody = { globalAlias: string } | { localAlias: string; accessKeyId: string };

type WholeNumber = { kind: "digits"; text: string } | { kind: "unset" };

type Quotas = {
  maxSize: WholeNumber;
  maxObjects: WholeNumber;
};

type Bucket = {
  id: string;
  aliases: Alias[];
  objects: string | null;
  bytes: string | null;
  quotas: Quotas | null;
};

type BucketPage = {
  items: Bucket[];
  hasMore: boolean;
};

type AliasDraft = {
  scope: "global" | "local";
  globalAlias: string;
  localAlias: string;
  accessKeyId: string;
};

const blankAliasDraft: AliasDraft = {
  scope: "global",
  globalAlias: "",
  localAlias: "",
  accessKeyId: "",
};

// 服务端未传 limit 时窗口是 100。下一页 offset 用本页条数。
const PAGE_LIMIT = 100;

function parseAlias(value: unknown, scope: "global" | "local"): Alias | null {
  if (typeof value === "string") {
    return scope === "global"
      ? { scope: "global", name: value }
      : { scope: "local", name: value, accessKeyId: null };
  }
  if (typeof value !== "object" || value === null || !("alias" in value)) {
    return null;
  }
  const record = value as { alias?: unknown; accessKeyId?: unknown };
  if (typeof record.alias !== "string") {
    return null;
  }
  if (scope === "global") {
    return { scope: "global", name: record.alias };
  }
  return {
    scope: "local",
    name: record.alias,
    accessKeyId: typeof record.accessKeyId === "string" ? record.accessKeyId : null,
  };
}

function parseAliases(value: unknown, scope: "global" | "local"): Alias[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const aliases: Alias[] = [];
  for (const entry of value) {
    const alias = parseAlias(entry, scope);
    if (alias !== null) {
      aliases.push(alias);
    }
  }
  return aliases;
}

const COUNT_KEYS = new Set(["objects", "bytes", "maxSize", "maxObjects"]);

const DECIMAL_UNITS = [
  ["PB", 15],
  ["TB", 12],
  ["GB", 9],
  ["MB", 6],
  ["KB", 3],
] as const;

function parseBucket(value: unknown): Bucket {
  if (typeof value !== "object" || value === null) {
    throw new Error("Buckets are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error("Buckets are unavailable");
  }
  return {
    id: row.id,
    aliases: [...parseAliases(row.globalAliases, "global"), ...parseAliases(row.localAliases, "local")],
    objects: digitsOf(row.objects),
    bytes: digitsOf(row.bytes),
    quotas: parseQuotas(row.quotas),
  };
}

function digitsOf(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return value;
  }
  return null;
}

function parseQuotas(value: unknown): Quotas | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const maxSize = quotaValue(row.maxSize);
  const maxObjects = quotaValue(row.maxObjects);
  if (maxSize === null || maxObjects === null) {
    return null;
  }
  return { maxSize, maxObjects };
}

function quotaValue(value: unknown): WholeNumber | null {
  if (value === undefined || value === null) {
    return { kind: "unset" };
  }
  const text = digitsOf(value);
  if (text === null) {
    return null;
  }
  return { kind: "digits", text };
}

function parsePage(text: string): BucketPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteCountLiterals(text)) as unknown;
  } catch {
    throw new Error("Buckets are unavailable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Buckets are unavailable");
  }
  const page = parsed as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Buckets are unavailable");
  }
  return {
    items: page.items.map(parseBucket),
    hasMore: page.hasMore,
  };
}

// JSON.parse 会把 9007199254740993 收成 9007199254740992。配额和用量按响应原文保留。
function quoteCountLiterals(text: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      parts.push(text[index]);
      index += 1;
      continue;
    }
    const end = endOfString(text, index);
    const raw = text.slice(index, end);
    parts.push(raw);
    index = end;
    let key = "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string") {
        key = parsed;
      }
    } catch {
      key = "";
    }
    if (!COUNT_KEYS.has(key)) {
      continue;
    }
    const colon = skipWs(text, index);
    if (text[colon] !== ":") {
      continue;
    }
    const valueAt = skipWs(text, colon + 1);
    const numberEnd = endOfDigits(text, valueAt);
    if (numberEnd === valueAt) {
      continue;
    }
    parts.push(text.slice(index, valueAt));
    parts.push(`"${text.slice(valueAt, numberEnd)}"`);
    index = numberEnd;
  }
  return parts.join("");
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

function nextOffset(offset: number, page: BucketPage): number | undefined {
  if (!page.hasMore || page.items.length === 0) {
    return undefined;
  }
  return offset + page.items.length;
}

function createBody(globalAlias: string): { globalAlias?: string } {
  if (globalAlias.trim().length === 0) {
    return {};
  }
  return { globalAlias };
}

function draftBody(draft: AliasDraft): AliasBody {
  if (draft.scope === "global") {
    return { globalAlias: draft.globalAlias };
  }
  return { localAlias: draft.localAlias, accessKeyId: draft.accessKeyId };
}

function removeBody(alias: Alias): AliasBody | null {
  if (alias.scope === "global") {
    return { globalAlias: alias.name };
  }
  if (alias.accessKeyId === null) {
    return null;
  }
  return { localAlias: alias.name, accessKeyId: alias.accessKeyId };
}

function removeLabel(alias: Alias): string | null {
  if (alias.scope === "global") {
    return `Remove global alias ${alias.name}`;
  }
  if (alias.accessKeyId === null) {
    return null;
  }
  return `Remove local alias ${alias.name} for ${alias.accessKeyId}`;
}

type BucketListFailure = {
  message: string;
  code: string | null;
};

class BucketListError extends Error {
  readonly code: string | null;

  constructor(failure: BucketListFailure) {
    super(failure.message);
    this.name = "BucketListError";
    this.code = failure.code;
  }
}

// api() 只把 message 放进 Error。桶列表还要显示 body 里的 code，所以这里自己读响应。
function failureFrom(text: string, status: number): BucketListFailure {
  const fallback = `request failed (${status})`;
  if (!text.startsWith("{")) {
    return { message: fallback, code: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { message: fallback, code: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { message: fallback, code: null };
  }
  const body = parsed as Record<string, unknown>;
  const message =
    typeof body.message === "string" && body.message.length > 0 ? body.message : fallback;
  const code = typeof body.code === "string" && body.code.length > 0 ? body.code : null;
  return { message, code };
}

function bucketListFailure(error: unknown): BucketListFailure {
  if (error instanceof BucketListError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null };
  }
  return { message: "Buckets are unavailable", code: null };
}

async function loadPage(offset: number): Promise<BucketPage> {
  const response = await fetch(`/api/buckets?offset=${offset}&limit=${PAGE_LIMIT}`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BucketListError(failureFrom(text, response.status));
  }
  return parsePage(text);
}

function objectUsage(bucket: Bucket): string | null {
  const used = bucket.objects;
  const quota = bucket.quotas?.maxObjects;
  if (used !== null && quota?.kind === "digits") {
    return `${used} of ${quota.text} objects`;
  }
  if (used !== null && quota?.kind === "unset") {
    return `${used} objects. Object quota is not set`;
  }
  if (used !== null) {
    return `${used} objects`;
  }
  if (quota?.kind === "digits") {
    return `Object quota ${quota.text}`;
  }
  if (quota?.kind === "unset") {
    return "Object quota is not set";
  }
  return null;
}

function byteUsage(bucket: Bucket): string | null {
  const used = bucket.bytes;
  const quota = bucket.quotas?.maxSize;
  if (used !== null && quota?.kind === "digits") {
    return `${used} of ${quota.text} bytes${unitPair(used, quota.text)}`;
  }
  if (used !== null && quota?.kind === "unset") {
    return `${used} bytes${unitSingle(used)}. Size quota is not set`;
  }
  if (used !== null) {
    return `${used} bytes${unitSingle(used)}`;
  }
  if (quota?.kind === "digits") {
    return `Size quota ${quota.text} bytes${unitSingle(quota.text)}`;
  }
  if (quota?.kind === "unset") {
    return "Size quota is not set";
  }
  return null;
}

function unitSingle(digits: string): string {
  const shown = formatBytes(digits);
  if (shown.endsWith(" B")) {
    return "";
  }
  return ` (${shown})`;
}

function unitPair(used: string, quota: string): string {
  const left = formatBytes(used);
  const right = formatBytes(quota);
  if (left.endsWith(" B") && right.endsWith(" B")) {
    return "";
  }
  return ` (${left} of ${right})`;
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

function fieldText(value: WholeNumber): string {
  return value.kind === "digits" ? value.text : "";
}

function fieldLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "null";
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function UsageText({ bucket }: { bucket: Bucket }) {
  const objects = objectUsage(bucket);
  const bytes = byteUsage(bucket);
  if (objects === null && bytes === null) {
    return null;
  }
  return (
    <div>
      {objects ? <p>{objects}</p> : null}
      {bytes ? <p>{bytes}</p> : null}
    </div>
  );
}

function QuotaEditor({ bucketId, quotas }: { bucketId: string; quotas: Quotas }) {
  const client = useQueryClient();
  const [maxSize, setMaxSize] = useState(fieldText(quotas.maxSize));
  const [maxObjects, setMaxObjects] = useState(fieldText(quotas.maxObjects));
  const [rejected, setRejected] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/quotas`, { method: "PUT", body }),
    onMutate: () => {
      setRejected(null);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const apiError = save.error instanceof Error ? save.error.message : null;
  const error = rejected ?? apiError;
  return (
    <form
      className="mt-3 grid max-w-sm gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const size = fieldLiteral(maxSize);
        const objects = fieldLiteral(maxObjects);
        if (size === null || objects === null) {
          save.reset();
          setRejected("Enter a whole number or leave the quota empty");
          return;
        }
        save.mutate(`{"maxSize":${size},"maxObjects":${objects}}`);
      }}
    >
      <label className="block text-sm">
        Max size for {bucketId}
        <input
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          inputMode="numeric"
          autoComplete="off"
          value={maxSize}
          onChange={(event) => {
            setMaxSize(event.target.value);
          }}
        />
      </label>
      <label className="block text-sm">
        Max objects for {bucketId}
        <input
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          inputMode="numeric"
          autoComplete="off"
          value={maxObjects}
          onChange={(event) => {
            setMaxObjects(event.target.value);
          }}
        />
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={save.isPending}
      >
        {save.isPending ? "Saving quotas" : `Save quotas for ${bucketId}`}
      </button>
    </form>
  );
}

function CreateBucketForm() {
  const client = useQueryClient();
  const [globalAlias, setGlobalAlias] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (alias: string) =>
      api("/api/buckets", { method: "POST", body: JSON.stringify(createBody(alias)) }),
    onMutate: () => {
      setNote(null);
    },
    onSuccess: async () => {
      setGlobalAlias("");
      setNote("Bucket created");
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <form
      className="grid max-w-sm gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(globalAlias);
      }}
    >
      <label className="block">
        <span className="text-sm">Global alias</span>
        <input
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          value={globalAlias}
          onChange={(event) => {
            setGlobalAlias(event.target.value);
          }}
        />
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {note ? <p>{note}</p> : null}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={create.isPending}
      >
        {create.isPending ? "Creating bucket" : "Create bucket"}
      </button>
    </form>
  );
}

function AliasControls({ bucketId }: { bucketId: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(blankAliasDraft);
  const [note, setNote] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (body: AliasBody) =>
      api(`${bucketUrl(bucketId)}/aliases`, { method: "POST", body: JSON.stringify(body) }),
    onMutate: () => {
      setNote(null);
    },
    onSuccess: async () => {
      setDraft({ ...blankAliasDraft });
      setNote("Alias added");
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const error = add.error instanceof Error ? add.error.message : null;
  return (
    <form
      className="mt-3 grid max-w-sm gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(draftBody(draft));
      }}
    >
      <fieldset className="grid gap-1">
        <legend className="text-sm">Add alias to {bucketId}</legend>
        <label className="text-sm">
          <input
            className="mr-2"
            type="radio"
            name={`alias-scope-${bucketId}`}
            checked={draft.scope === "global"}
            onChange={() => {
              setDraft((current) => ({ ...current, scope: "global" }));
            }}
          />
          Global for {bucketId}
        </label>
        <label className="text-sm">
          <input
            className="mr-2"
            type="radio"
            name={`alias-scope-${bucketId}`}
            checked={draft.scope === "local"}
            onChange={() => {
              setDraft((current) => ({ ...current, scope: "local" }));
            }}
          />
          Local for {bucketId}
        </label>
      </fieldset>
      {draft.scope === "global" ? (
        <label className="block text-sm">
          Global alias for {bucketId}
          <input
            className="mt-1 w-full border border-neutral-300 px-2 py-1"
            value={draft.globalAlias}
            onChange={(event) => {
              setDraft((current) => ({ ...current, globalAlias: event.target.value }));
            }}
          />
        </label>
      ) : (
        <>
          <label className="block text-sm">
            Local alias for {bucketId}
            <input
              className="mt-1 w-full border border-neutral-300 px-2 py-1"
              value={draft.localAlias}
              onChange={(event) => {
                setDraft((current) => ({ ...current, localAlias: event.target.value }));
              }}
            />
          </label>
          <label className="block text-sm">
            Access key for {bucketId}
            <input
              className="mt-1 w-full border border-neutral-300 px-2 py-1"
              value={draft.accessKeyId}
              onChange={(event) => {
                setDraft((current) => ({ ...current, accessKeyId: event.target.value }));
              }}
            />
          </label>
        </>
      )}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {note ? <p>{note}</p> : null}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={add.isPending}
      >
        {add.isPending ? "Adding alias" : `Add alias to ${bucketId}`}
      </button>
    </form>
  );
}

function RemoveAliasButton({ bucketId, alias }: { bucketId: string; alias: Alias }) {
  const client = useQueryClient();
  const body = removeBody(alias);
  const label = removeLabel(alias);
  const remove = useMutation({
    mutationFn: (payload: AliasBody) =>
      api(`${bucketUrl(bucketId)}/aliases`, { method: "DELETE", body: JSON.stringify(payload) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  if (body === null || label === null) {
    return null;
  }
  const error = remove.error instanceof Error ? remove.error.message : null;
  return (
    <>
      <button
        className="ml-2 border border-neutral-900 px-2 py-1 text-left"
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          remove.mutate(body);
        }}
      >
        {remove.isPending ? "Removing alias" : label}
      </button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </>
  );
}

function DeleteBucketDialog({
  bucketId,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  bucketId: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      dialog.setAttribute("open", "");
    }
    cancelRef.current?.focus();
  }, [bucketId]);
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="delete-bucket-title"
      className="border border-neutral-900 bg-white p-4 text-neutral-900"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <h3 id="delete-bucket-title" className="font-medium">
        Delete bucket {bucketId}
      </h3>
      <p>
        This permanently deletes bucket {bucketId} and its aliases. Garage rejects the request when
        the bucket still contains objects.
      </p>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        ref={cancelRef}
        className="mr-2 border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={onCancel}
      >
        Cancel
      </button>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        disabled={pending}
        onClick={onConfirm}
      >
        {pending ? "Deleting bucket" : "Delete bucket"}
      </button>
    </dialog>
  );
}

export function Buckets({ canManage = false }: { canManage?: boolean }) {
  const client = useQueryClient();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hash, assignHash] = useLocationHash();
  const location = bucketLocationFromHash(hash);
  const browsing = location.kind === "objects";
  const list = useInfiniteQuery({
    queryKey: ["buckets"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => loadPage(pageParam),
    getNextPageParam: (page, _pages, offset) => nextOffset(offset, page),
  });
  const removeBucket = useMutation({
    mutationFn: (id: string) => api(bucketUrl(id), { method: "DELETE" }),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: async () => {
      setDeleteId(null);
      setNotice("Bucket deleted");
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = list.isPending;
  const refreshing = rows.length > 0 && list.isFetching && !list.isPending;
  const view = {
    loading,
    refreshing,
    busy: loading || refreshing,
    empty: Boolean(list.data) && rows.length === 0,
    failure: list.isError ? bucketListFailure(list.error) : null,
    partial: list.hasNextPage,
  };
  const deleteError = removeBucket.error instanceof Error ? removeBucket.error.message : null;

  return (
    <section className="grid gap-4" aria-label="Buckets" aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">Buckets</h2>
      {canManage && !browsing ? <CreateBucketForm /> : null}
      {view.loading ? <p>Loading buckets</p> : null}
      {view.refreshing ? <p>Refreshing buckets</p> : null}
      {view.failure ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void list.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {notice ? <p>{notice}</p> : null}
      {browsing ? (
        <Objects
          key={location.bucketId}
          bucketId={location.bucketId}
          onBack={() => {
            assignHash("#buckets");
          }}
        />
      ) : null}
      {view.empty ? <p>There are no buckets.</p> : null}
      {!browsing && list.data && rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Bucket
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Usage
                </th>
                <th className="py-2 font-medium" scope="col">
                  Aliases
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bucket, index) => (
                <tr key={`${bucket.id}-${index}`}>
                  <td className="py-2 pr-3 align-top">
                    <span>{bucket.id}</span>
                    <button
                      className="ml-2 border border-neutral-900 px-2 py-1 text-left"
                      type="button"
                      onClick={() => {
                        assignHash(hashForObjects(bucket.id, ""));
                      }}
                    >
                      Objects for {bucket.id}
                    </button>
                    <BucketPermissions bucketId={bucket.id} canManage={canManage} />
                    {canManage ? (
                      <button
                        className="ml-2 border border-neutral-900 px-2 py-1 text-left"
                        type="button"
                        onClick={() => {
                          removeBucket.reset();
                          setDeleteId(bucket.id);
                        }}
                      >
                        Delete {bucket.id}
                      </button>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <UsageText bucket={bucket} />
                    {canManage && bucket.quotas ? (
                      <QuotaEditor
                        key={`${index}:${fieldText(bucket.quotas.maxSize)}:${fieldText(bucket.quotas.maxObjects)}`}
                        bucketId={bucket.id}
                        quotas={bucket.quotas}
                      />
                    ) : null}
                  </td>
                  <td className="py-2 align-top">
                    {bucket.aliases.map((alias, aliasIndex) => (
                      <Fragment key={`${bucket.id}-${aliasIndex}`}>
                        {aliasIndex > 0 ? ", " : null}
                        <span>{alias.name}</span>
                        {canManage ? <RemoveAliasButton bucketId={bucket.id} alias={alias} /> : null}
                      </Fragment>
                    ))}
                    {canManage ? <AliasControls bucketId={bucket.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!browsing && view.partial ? (
        <>
          <p>More buckets are available.</p>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            Load more
          </button>
        </>
      ) : null}
      {deleteId !== null ? (
        <DeleteBucketDialog
          bucketId={deleteId}
          pending={removeBucket.isPending}
          error={deleteError}
          onCancel={() => {
            setDeleteId(null);
            removeBucket.reset();
          }}
          onConfirm={() => {
            removeBucket.mutate(deleteId);
          }}
        />
      ) : null}
    </section>
  );
}
