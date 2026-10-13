import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { BucketPermissions, bucketUrl } from "./BucketPermissions";
import { DetailTabs } from "./DetailTabs";
import {
  bucketLocationFromHash,
  bucketTabs,
  detailAddressFromHash,
  hashForDetail,
  hashForObjects,
  useLocationHash,
} from "./Nav";
import { Objects } from "./Objects";
import { releaseHash, savePhase, saveStatus, setFormDirty } from "./unsaved";

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
  created: string | null;
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

// Without a limit the server window is 100. The next offset is this page's row count.
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
    created: createdTime(row.created),
  };
}

function createdTime(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
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

// JSON.parse turns 9007199254740993 into 9007199254740992. Keep quota and usage digits as response text.
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

// api() puts only message on Error. The bucket list also shows the body's code, so read the response here.
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
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    throw new BucketListError(failure);
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

// Split the original digit text on decimal units. Skip Number so byte counts past 2^53 are not rounded.
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
  const loadedSize = fieldText(quotas.maxSize);
  const loadedObjects = fieldText(quotas.maxObjects);
  const [maxSize, setMaxSize] = useState(loadedSize);
  const [maxObjects, setMaxObjects] = useState(loadedObjects);
  const [savedSize, setSavedSize] = useState(loadedSize);
  const [savedObjects, setSavedObjects] = useState(loadedObjects);
  const [rejected, setRejected] = useState<string | null>(null);
  const submitted = useRef({ size: loadedSize, objects: loadedObjects });
  const quotaDirty = maxSize !== savedSize || maxObjects !== savedObjects;
  useEffect(() => {
    setFormDirty(`quota:${bucketId}`, quotaDirty);
    return () => setFormDirty(`quota:${bucketId}`, false);
  }, [bucketId, quotaDirty]);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/quotas`, { method: "PUT", body }),
    onMutate: () => {
      submitted.current = { size: maxSize, objects: maxObjects };
      setRejected(null);
    },
    onSuccess: async () => {
      setSavedSize(submitted.current.size);
      setSavedObjects(submitted.current.objects);
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const apiError = save.error instanceof Error ? save.error.message : null;
  const error = rejected ?? apiError;
  const quotaStatus = saveStatus(
    savePhase(save.isPending, rejected !== null || save.isError, save.isSuccess),
    quotaDirty,
    "Saved",
  );
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
      {quotaStatus ? <p>{quotaStatus}</p> : null}
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

type CorsDraft = {
  id: string;
  origins: string;
  methods: string;
  headers: string;
  expose: string;
  maxAge: string;
  extra: Record<string, unknown>;
  preserved: unknown;
};

const CORS_FIELDS = [
  ["id", "ID"],
  ["origins", "AllowedOrigin"],
  ["methods", "AllowedMethod"],
  ["headers", "AllowedHeader"],
  ["expose", "ExposeHeader"],
  ["maxAge", "MaxAgeSeconds"],
] as const;

function emptyCorsDraft(): CorsDraft {
  return {
    id: "",
    origins: "",
    methods: "",
    headers: "",
    expose: "",
    maxAge: "",
    extra: {},
    preserved: undefined,
  };
}

function splitCsv(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function joinCsv(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      items.push(item);
    }
  }
  return items.join(", ");
}

function maxAgeText(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return value;
  }
  return "";
}

function draftFromRule(value: unknown): CorsDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...emptyCorsDraft(), preserved: value };
  }
  const record = value as Record<string, unknown>;
  const extra = { ...record };
  delete extra.ID;
  delete extra.AllowedOrigin;
  delete extra.AllowedMethod;
  delete extra.AllowedHeader;
  delete extra.ExposeHeader;
  delete extra.MaxAgeSeconds;
  return {
    id: typeof record.ID === "string" ? record.ID : "",
    origins: joinCsv(record.AllowedOrigin),
    methods: joinCsv(record.AllowedMethod),
    headers: joinCsv(record.AllowedHeader),
    expose: joinCsv(record.ExposeHeader),
    maxAge: maxAgeText(record.MaxAgeSeconds),
    extra,
    preserved: undefined,
  };
}

function draftsFromCors(payload: unknown): CorsDraft[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }
  const rules = (payload as { corsRules?: unknown }).corsRules;
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.map(draftFromRule);
}

function ageReady(value: string): boolean {
  const text = value.trim();
  return text.length === 0 || /^[0-9]+$/.test(text);
}

function ruleReady(rule: CorsDraft): boolean {
  if (rule.preserved !== undefined) {
    return true;
  }
  return (
    rule.id.trim().length > 0 &&
    splitCsv(rule.origins).length > 0 &&
    splitCsv(rule.methods).length > 0 &&
    ageReady(rule.maxAge)
  );
}

function encodeRule(rule: CorsDraft): string {
  if (rule.preserved !== undefined) {
    return JSON.stringify(rule.preserved);
  }
  const fields: Record<string, unknown> = {
    ...rule.extra,
    ID: rule.id.trim(),
    AllowedOrigin: splitCsv(rule.origins),
    AllowedMethod: splitCsv(rule.methods),
    AllowedHeader: splitCsv(rule.headers),
    ExposeHeader: splitCsv(rule.expose),
  };
  delete fields.MaxAgeSeconds;
  const age = rule.maxAge.trim();
  const base = JSON.stringify(fields);
  if (age.length === 0) {
    return base;
  }
  return `${base.slice(0, -1)},"MaxAgeSeconds":${age}}`;
}

function corsBody(rules: CorsDraft[]): string {
  return `{"corsRules":[${rules.map(encodeRule).join(",")}]}`;
}

function nextCorsText(rules: CorsDraft[]): string {
  return `[${rules.map(encodeRule).join(",")}]`;
}

function CorsSummary({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: ["bucket-cors", bucketId, "view"],
    queryFn: () => api<unknown>(`${bucketUrl(bucketId)}/cors`),
    refetchOnWindowFocus: false,
  });
  if (!query.isSuccess) {
    return null;
  }
  return (
    <div>
      {draftsFromCors(query.data).map((rule, index) =>
        rule.preserved !== undefined ? (
          <p key={index}>{JSON.stringify(rule.preserved)}</p>
        ) : (
          <p key={index}>
            <span>{rule.id}</span>
            {splitCsv(rule.origins).map((origin, originIndex) => (
              <span key={originIndex}>{origin}</span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

function CorsEditor({ bucketId }: { bucketId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        className="mt-3 border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit CORS
      </button>
    );
  }
  return <CorsForm bucketId={bucketId} />;
}

function CorsForm({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: ["bucket-cors", bucketId],
    queryFn: () => api<unknown>(`${bucketUrl(bucketId)}/cors`),
    refetchOnWindowFocus: false,
  });
  const [drafts, setDrafts] = useState<CorsDraft[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    if (query.isSuccess && drafts === null) {
      setDrafts(draftsFromCors(query.data));
    }
  }, [query.isSuccess, query.data, drafts]);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/cors`, { method: "PUT", body }),
  });
  if (query.isError) {
    return <p>{query.error instanceof Error ? query.error.message : "CORS rules are unavailable"}</p>;
  }
  if (drafts === null) {
    return null;
  }
  const ready = drafts.every(ruleReady);
  const replaceRule = (index: number, rule: CorsDraft) => {
    setDrafts(drafts.map((item, itemIndex) => (itemIndex === index ? rule : item)));
  };
  return (
    <div className="mt-3 grid max-w-sm gap-2">
      {drafts.map((rule, index) => (
        <div key={index} className="grid gap-2">
          {rule.preserved !== undefined ? (
            <p>{JSON.stringify(rule.preserved)}</p>
          ) : (
            CORS_FIELDS.map(([key, label]) => (
              <label key={label} className="block text-sm">
                {label}
                <input
                  className="mt-1 w-full border border-neutral-300 px-2 py-1"
                  value={rule[key]}
                  onChange={(event) => {
                    replaceRule(index, { ...rule, [key]: event.target.value });
                  }}
                />
              </label>
            ))
          )}
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              setDrafts(drafts.filter((_, itemIndex) => itemIndex !== index));
            }}
          >
            Remove CORS rule
          </button>
        </div>
      ))}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setDrafts([...drafts, emptyCorsDraft()]);
        }}
      >
        Add CORS rule
      </button>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        disabled={!ready}
        onClick={() => {
          setReviewError(null);
          void api<unknown>(`${bucketUrl(bucketId)}/cors`)
            .then((fresh) => {
              setCurrent(JSON.stringify(fresh));
            })
            .catch((error: unknown) => {
              setCurrent(null);
              setReviewError(error instanceof Error ? error.message : "CORS rules are unavailable");
            });
        }}
      >
        Review CORS
      </button>
      {reviewError ? <p>{reviewError}</p> : null}
      {current !== null ? (
        <>
          <pre aria-label="Current">{current}</pre>
          <pre aria-label="Next">{nextCorsText(drafts)}</pre>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              setCurrent(null);
            }}
          >
            Cancel
          </button>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={save.isPending || !ready}
            onClick={() => {
              save.mutate(corsBody(drafts));
            }}
          >
            Save CORS
          </button>
          {save.error instanceof Error ? <p>{save.error.message}</p> : null}
        </>
      ) : null}
    </div>
  );
}

type LifecycleDraft = {
  id: string;
  status: string;
  prefix: string;
  greaterThan: string;
  lessThan: string;
  days: string;
  date: string;
  abortDays: string;
  extra: Record<string, unknown>;
  filterExtra: Record<string, unknown>;
  expirationExtra: Record<string, unknown>;
  abortExtra: Record<string, unknown>;
  preserved: unknown;
};

const LIFECYCLE_FIELDS = [
  ["id", "ID"],
  ["status", "Status"],
  ["prefix", "Filter.Prefix"],
  ["greaterThan", "Filter.ObjectSizeGreaterThan"],
  ["lessThan", "Filter.ObjectSizeLessThan"],
  ["days", "Expiration.Days"],
  ["date", "Expiration.Date"],
  ["abortDays", "AbortIncompleteMultipartUpload.DaysAfterInitiation"],
] as const;

function emptyLifecycleDraft(): LifecycleDraft {
  return {
    id: "",
    status: "",
    prefix: "",
    greaterThan: "",
    lessThan: "",
    days: "",
    date: "",
    abortDays: "",
    extra: {},
    filterExtra: {},
    expirationExtra: {},
    abortExtra: {},
    preserved: undefined,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function omitKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!keys.includes(key)) {
      extra[key] = item;
    }
  }
  return extra;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "invalid";
}

function draftFromLifecycleRule(value: unknown): LifecycleDraft {
  const record = objectRecord(value);
  if (record === null) {
    return { ...emptyLifecycleDraft(), preserved: value };
  }
  const filter = objectRecord(record.Filter);
  const expiration = objectRecord(record.Expiration);
  const abort = objectRecord(record.AbortIncompleteMultipartUpload);
  if (
    (record.Filter !== undefined && record.Filter !== null && filter === null) ||
    (record.Expiration !== undefined && record.Expiration !== null && expiration === null) ||
    (record.AbortIncompleteMultipartUpload !== undefined &&
      record.AbortIncompleteMultipartUpload !== null &&
      abort === null)
  ) {
    return { ...emptyLifecycleDraft(), preserved: value };
  }
  return {
    id: typeof record.ID === "string" ? record.ID : "",
    status: typeof record.Status === "string" ? record.Status : "",
    prefix: filter ? textField(filter.Prefix) : "",
    greaterThan: filter ? integerText(filter.ObjectSizeGreaterThan) : "",
    lessThan: filter ? integerText(filter.ObjectSizeLessThan) : "",
    days: expiration ? integerText(expiration.Days) : "",
    date: expiration ? textField(expiration.Date) : "",
    abortDays: abort ? integerText(abort.DaysAfterInitiation) : "",
    extra: omitKeys(record, ["ID", "Status", "Filter", "Expiration", "AbortIncompleteMultipartUpload"]),
    filterExtra: filter ? omitKeys(filter, ["Prefix", "ObjectSizeGreaterThan", "ObjectSizeLessThan"]) : {},
    expirationExtra: expiration ? omitKeys(expiration, ["Days", "Date"]) : {},
    abortExtra: abort ? omitKeys(abort, ["DaysAfterInitiation"]) : {},
    preserved: undefined,
  };
}

function draftsFromLifecycle(payload: unknown): LifecycleDraft[] {
  const record = objectRecord(payload);
  if (record === null || !Array.isArray(record.lifecycleRules)) {
    return [];
  }
  return record.lifecycleRules.map(draftFromLifecycleRule);
}

function integerFieldReady(value: string): boolean {
  const text = value.trim();
  return text.length === 0 || /^[0-9]+$/.test(text);
}

function digitLess(left: string, right: string): boolean {
  const a = left.replace(/^0+/, "") || "0";
  const b = right.replace(/^0+/, "") || "0";
  if (a.length !== b.length) {
    return a.length < b.length;
  }
  return a < b;
}

function lifecycleReady(rule: LifecycleDraft): boolean {
  if (rule.preserved !== undefined) {
    return true;
  }
  if (rule.days.trim().length > 0 && rule.date.trim().length > 0) {
    return false;
  }
  const greater = rule.greaterThan.trim();
  const less = rule.lessThan.trim();
  const bounds = !/^[0-9]+$/.test(greater) || !/^[0-9]+$/.test(less) || digitLess(greater, less);
  return (
    rule.id.trim().length > 0 &&
    (rule.status.trim() === "Enabled" || rule.status.trim() === "Disabled") &&
    integerFieldReady(rule.greaterThan) &&
    integerFieldReady(rule.lessThan) &&
    integerFieldReady(rule.days) &&
    integerFieldReady(rule.abortDays) &&
    bounds
  );
}

function digitLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function jsonObject(entries: Array<[string, string]>): string {
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}

function rawEntries(record: Record<string, unknown>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) {
      entries.push([key, encoded]);
    }
  }
  return entries;
}

function encodeFilter(rule: LifecycleDraft): string | null {
  const entries = rawEntries(rule.filterExtra);
  if (rule.prefix.trim().length > 0) {
    entries.push(["Prefix", JSON.stringify(rule.prefix)]);
  }
  const greater = digitLiteral(rule.greaterThan);
  if (greater !== null) {
    entries.push(["ObjectSizeGreaterThan", greater]);
  }
  const less = digitLiteral(rule.lessThan);
  if (less !== null) {
    entries.push(["ObjectSizeLessThan", less]);
  }
  if (entries.length === 0) {
    return null;
  }
  return jsonObject(entries);
}

function encodeExpiration(rule: LifecycleDraft): string | null {
  const entries = rawEntries(rule.expirationExtra);
  const days = digitLiteral(rule.days);
  if (days !== null) {
    entries.push(["Days", days]);
  }
  if (rule.date.trim().length > 0) {
    entries.push(["Date", JSON.stringify(rule.date.trim())]);
  }
  if (entries.length === 0) {
    return null;
  }
  return jsonObject(entries);
}

function encodeAbort(rule: LifecycleDraft): string | null {
  const entries = rawEntries(rule.abortExtra);
  const days = digitLiteral(rule.abortDays);
  if (days !== null) {
    entries.push(["DaysAfterInitiation", days]);
  }
  if (entries.length === 0) {
    return null;
  }
  return jsonObject(entries);
}

function encodeLifecycleRule(rule: LifecycleDraft): string {
  if (rule.preserved !== undefined) {
    return JSON.stringify(rule.preserved);
  }
  const entries = rawEntries(rule.extra);
  entries.push(["ID", JSON.stringify(rule.id.trim())]);
  entries.push(["Status", JSON.stringify(rule.status.trim())]);
  const filter = encodeFilter(rule);
  if (filter !== null) {
    entries.push(["Filter", filter]);
  }
  const expiration = encodeExpiration(rule);
  if (expiration !== null) {
    entries.push(["Expiration", expiration]);
  }
  const abort = encodeAbort(rule);
  if (abort !== null) {
    entries.push(["AbortIncompleteMultipartUpload", abort]);
  }
  return jsonObject(entries);
}

function lifecycleBody(rules: LifecycleDraft[]): string {
  return `{"lifecycleRules":[${rules.map(encodeLifecycleRule).join(",")}]}`;
}

function nextLifecycleText(rules: LifecycleDraft[]): string {
  return `[${rules.map(encodeLifecycleRule).join(",")}]`;
}

function LifecycleSummary({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: ["bucket-lifecycle", bucketId, "view"],
    queryFn: () => api<unknown>(`${bucketUrl(bucketId)}/lifecycle`),
    refetchOnWindowFocus: false,
  });
  if (!query.isSuccess) {
    return null;
  }
  return (
    <div>
      {draftsFromLifecycle(query.data).map((rule, index) =>
        rule.preserved !== undefined ? (
          <p key={index}>{JSON.stringify(rule.preserved)}</p>
        ) : (
          <p key={index}>
            <span>{rule.id}</span>
            <span>{rule.status}</span>
          </p>
        ),
      )}
    </div>
  );
}

function LifecycleEditor({ bucketId }: { bucketId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        className="mt-3 border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Edit lifecycle
      </button>
    );
  }
  return <LifecycleForm bucketId={bucketId} />;
}

function LifecycleForm({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: ["bucket-lifecycle", bucketId],
    queryFn: () => api<unknown>(`${bucketUrl(bucketId)}/lifecycle`),
    refetchOnWindowFocus: false,
  });
  const [drafts, setDrafts] = useState<LifecycleDraft[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    if (query.isSuccess && drafts === null) {
      setDrafts(draftsFromLifecycle(query.data));
    }
  }, [query.isSuccess, query.data, drafts]);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/lifecycle`, { method: "PUT", body }),
  });
  if (query.isError) {
    return (
      <p>{query.error instanceof Error ? query.error.message : "Lifecycle rules are unavailable"}</p>
    );
  }
  if (drafts === null) {
    return null;
  }
  const ready = drafts.every(lifecycleReady);
  const replaceRule = (index: number, rule: LifecycleDraft) => {
    setDrafts(drafts.map((item, itemIndex) => (itemIndex === index ? rule : item)));
  };
  return (
    <div className="mt-3 grid max-w-sm gap-2">
      {drafts.map((rule, index) => (
        <div key={index} className="grid gap-2">
          {rule.preserved !== undefined ? (
            <p>{JSON.stringify(rule.preserved)}</p>
          ) : (
            LIFECYCLE_FIELDS.map(([key, label]) => (
              <label key={label} className="block text-sm">
                {label}
                <input
                  className="mt-1 w-full border border-neutral-300 px-2 py-1"
                  value={rule[key]}
                  onChange={(event) => {
                    replaceRule(index, { ...rule, [key]: event.target.value });
                  }}
                />
              </label>
            ))
          )}
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              setDrafts(drafts.filter((_, itemIndex) => itemIndex !== index));
            }}
          >
            Remove lifecycle rule
          </button>
        </div>
      ))}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setDrafts([...drafts, emptyLifecycleDraft()]);
        }}
      >
        Add lifecycle rule
      </button>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        disabled={!ready}
        onClick={() => {
          setReviewError(null);
          void api<unknown>(`${bucketUrl(bucketId)}/lifecycle`)
            .then((fresh) => {
              setCurrent(JSON.stringify(fresh));
            })
            .catch((error: unknown) => {
              setCurrent(null);
              setReviewError(
                error instanceof Error ? error.message : "Lifecycle rules are unavailable",
              );
            });
        }}
      >
        Review lifecycle
      </button>
      {reviewError ? <p>{reviewError}</p> : null}
      {current !== null ? (
        <>
          <pre aria-label="Current">{current}</pre>
          <pre aria-label="Next">{nextLifecycleText(drafts)}</pre>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              setCurrent(null);
            }}
          >
            Cancel
          </button>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={save.isPending || !ready}
            onClick={() => {
              save.mutate(lifecycleBody(drafts));
            }}
          >
            Save lifecycle
          </button>
          {save.error instanceof Error ? <p>{save.error.message}</p> : null}
        </>
      ) : null}
    </div>
  );
}

type IncompleteUpload = {
  key: string;
  uploadId: string;
  initiated: string;
};

function olderThanSecs(hours: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(hours)) {
    return null;
  }
  const secs = Number(hours) * 3600;
  return Number.isSafeInteger(secs) ? secs : null;
}

function uploadsFrom(body: unknown): IncompleteUpload[] {
  if (typeof body !== "object" || body === null || !("uploads" in body)) {
    return [];
  }
  const uploads = (body as { uploads: unknown }).uploads;
  if (!Array.isArray(uploads)) {
    return [];
  }
  const rows: IncompleteUpload[] = [];
  for (const item of uploads) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as { key?: unknown; uploadId?: unknown; initiated?: unknown };
    if (
      typeof record.key !== "string" ||
      typeof record.uploadId !== "string" ||
      typeof record.initiated !== "string"
    ) {
      continue;
    }
    rows.push({ key: record.key, uploadId: record.uploadId, initiated: record.initiated });
  }
  return rows;
}

function IncompleteUploads({ bucketId }: { bucketId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        className="mt-3 border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Incomplete uploads
      </button>
    );
  }
  return <IncompleteUploadsPanel bucketId={bucketId} />;
}

function IncompleteUploadsPanel({ bucketId }: { bucketId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["bucket-multipart", bucketId],
    queryFn: () => api<unknown>(`${bucketUrl(bucketId)}/multipart`),
    refetchOnWindowFocus: false,
  });
  const [hours, setHours] = useState("");
  const cleanup = useMutation({
    mutationFn: (secs: number) =>
      api(`${bucketUrl(bucketId)}/cleanup-uploads`, {
        method: "POST",
        body: JSON.stringify({ olderThanSecs: secs }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["bucket-multipart", bucketId] });
    },
  });
  if (query.isError) {
    return (
      <p>
        {query.error instanceof Error ? query.error.message : "Incomplete uploads are unavailable"}
      </p>
    );
  }
  if (!query.isSuccess) {
    return null;
  }
  const secs = olderThanSecs(hours);
  return (
    <div className="mt-3 grid max-w-sm gap-2">
      {uploadsFrom(query.data).map((upload) => (
        <p key={`${upload.key}:${upload.uploadId}`}>
          <span>{upload.key}</span>
          <span>{upload.uploadId}</span>
          <span>{upload.initiated}</span>
        </p>
      ))}
      <label className="block text-sm">
        Older than hours
        <input
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          inputMode="numeric"
          value={hours}
          onChange={(event) => {
            setHours(event.target.value);
          }}
        />
      </label>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        disabled={secs === null || cleanup.isPending}
        onClick={() => {
          if (secs === null) {
            return;
          }
          cleanup.mutate(secs);
        }}
      >
        Clean up
      </button>
      {cleanup.error instanceof Error ? <p>{cleanup.error.message}</p> : null}
    </div>
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

type BucketSort = "id" | "alias" | "created";

type BucketQuery = {
  filter: string;
  sort: BucketSort;
};

function bucketSortFrom(value: string | null): BucketSort {
  if (value === "alias" || value === "created") {
    return value;
  }
  return "id";
}

function readBucketQuery(): BucketQuery {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: params.get("buckets") ?? "",
    sort: bucketSortFrom(params.get("bucketsSort")),
  };
}

function replaceListQuery(params: URLSearchParams) {
  const search = params.toString();
  const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function writeBucketQuery(query: BucketQuery) {
  const params = new URLSearchParams(window.location.search);
  if (query.filter.length > 0) {
    params.set("buckets", query.filter);
  } else {
    params.delete("buckets");
  }
  if (query.sort === "id") {
    params.delete("bucketsSort");
  } else {
    params.set("bucketsSort", query.sort);
  }
  replaceListQuery(params);
}

function bucketMatches(bucket: Bucket, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  const needle = filter.toLowerCase();
  if (bucket.id.toLowerCase().includes(needle)) {
    return true;
  }
  return bucket.aliases.some((alias) => alias.name.toLowerCase().includes(needle));
}

function orderedBuckets(rows: Bucket[], sort: BucketSort): Bucket[] {
  switch (sort) {
    case "id":
      return rows;
    case "alias":
      return [...rows].sort((left, right) => {
        const a = left.aliases.map((alias) => alias.name).join(", ").toLowerCase();
        const b = right.aliases.map((alias) => alias.name).join(", ").toLowerCase();
        return a.localeCompare(b);
      });
    case "created":
      return [...rows].sort((left, right) => compareCreated(left.created, right.created));
  }
}

function compareCreated(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left < right ? -1 : 1;
}

// A caller that passes only canManage still shows object writes and preview.
export function Buckets({
  canManage = false,
  canWrite = canManage,
  canTransfer = canManage,
}: {
  canManage?: boolean;
  canWrite?: boolean;
  canTransfer?: boolean;
}) {
  const client = useQueryClient();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hash, assignHash] = useLocationHash();
  const goHash = (next: string) => {
    if (!releaseHash(next)) {
      return;
    }
    assignHash(next);
  };
  const location = bucketLocationFromHash(hash);
  const detail = detailAddressFromHash(hash);
  const bucketDetail = detail?.resource === "bucket" ? detail : null;
  const browsing = bucketDetail === null && location.kind === "objects";
  const listing = bucketDetail === null && !browsing;
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
  const [query, setQuery] = useState(readBucketQuery);
  useEffect(() => {
    const sync = () => setQuery(readBucketQuery());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedBuckets(
    rows.filter((bucket) => bucketMatches(bucket, query.filter)),
    query.sort,
  );
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
  const openedBucket =
    bucketDetail === null ? null : (rows.find((bucket) => bucket.id === bucketDetail.id) ?? null);

  return (
    <section className="grid gap-4" aria-label="Buckets" aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">Buckets</h2>
      {bucketDetail ? (
        <DetailTabs
          label={`Bucket ${bucketDetail.id}`}
          tabs={bucketTabs()}
          selected={bucketDetail.tab}
          hrefFor={(tab) => hashForDetail({ resource: "bucket", id: bucketDetail.id, tab })}
          onSelect={(tab) => {
            goHash(hashForDetail({ resource: "bucket", id: bucketDetail.id, tab }));
          }}
        >
          <p>{bucketDetail.id}</p>
          {bucketDetail.tab === "objects" ? (
            <Objects
              bucketId={bucketDetail.id}
              canWrite={canWrite}
              canTransfer={canTransfer}
              canManage={canManage}
              onBack={() => {
                goHash("#buckets");
              }}
            />
          ) : null}
          {bucketDetail.tab === "permissions" ? (
            <BucketPermissions bucketId={bucketDetail.id} canManage={canManage} expanded />
          ) : null}
          {bucketDetail.tab === "settings" && canManage && openedBucket?.quotas ? (
            <QuotaEditor
              key={`${openedBucket.id}:${fieldText(openedBucket.quotas.maxSize)}:${fieldText(openedBucket.quotas.maxObjects)}`}
              bucketId={openedBucket.id}
              quotas={openedBucket.quotas}
            />
          ) : null}
        </DetailTabs>
      ) : null}
      {canManage && listing ? <CreateBucketForm /> : null}
      {bucketDetail === null && view.loading ? (
        <div className="h-16 border border-line" aria-label="Loading buckets" />
      ) : null}
      {bucketDetail === null && view.refreshing ? <p>Refreshing buckets</p> : null}
      {bucketDetail === null && view.failure && !isGarageDown(view.failure) ? (
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
      {listing ? (
        <div className="grid max-w-sm gap-3">
          <label className="block text-sm">
            Filter buckets
            <input
              className="mt-1 w-full border border-neutral-900 px-2 py-1"
              value={query.filter}
              onChange={(event) => {
                const next = { filter: event.target.value, sort: query.sort };
                setQuery(next);
                writeBucketQuery(next);
              }}
            />
          </label>
          <label className="block text-sm">
            Sort buckets
            <select
              className="mt-1 w-full border border-neutral-900 px-2 py-1"
              value={query.sort}
              onChange={(event) => {
                const next = {
                  filter: query.filter,
                  sort: bucketSortFrom(event.target.value),
                };
                setQuery(next);
                writeBucketQuery(next);
              }}
            >
              <option value="id">Id</option>
              <option value="alias">Alias</option>
              <option value="created">Created</option>
            </select>
          </label>
          <p>Default order is Id.</p>
          <p>Only loaded rows</p>
        </div>
      ) : null}
      {location.kind === "objects" && bucketDetail === null ? (
        <Objects
          key={location.bucketId}
          bucketId={location.bucketId}
          canWrite={canWrite}
          canTransfer={canTransfer}
          canManage={canManage}
          onBack={() => {
            goHash("#buckets");
          }}
        />
      ) : null}
      {bucketDetail === null && view.empty ? (
        <p>
          {canManage && !browsing
            ? "There are no buckets. Create the first bucket."
            : "There are no buckets."}
        </p>
      ) : null}
      {listing && list.data && shown.length > 0 ? (
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
              {shown.map((bucket, index) => (
                <tr key={`${bucket.id}-${index}`}>
                  <td className="py-2 pr-3 align-top">
                    <span>{bucket.id}</span>
                    <button
                      className="ml-2 border border-neutral-900 px-2 py-1 text-left"
                      type="button"
                      onClick={() => {
                        goHash(hashForObjects(bucket.id, ""));
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
                    {canManage ? <CorsEditor bucketId={bucket.id} /> : <CorsSummary bucketId={bucket.id} />}
                    {canManage ? (
                      <>
                        <LifecycleEditor bucketId={bucket.id} />
                        <IncompleteUploads bucketId={bucket.id} />
                      </>
                    ) : (
                      <LifecycleSummary bucketId={bucket.id} />
                    )}
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
      {listing && view.partial ? (
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
