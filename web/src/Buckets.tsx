import { Button, Dialog, DropdownMenu, RadioGroup, Select, Table, TextField } from "@radix-ui/themes";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, captureAuthGeneration, noteUnauthenticated } from "./api/client";
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
import { DataCell, ResourceIdentity, SettingsSection } from "./ui";
import { CapacityText, CompactCapacityText, copy, fill, translate } from "./i18n";
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

const wrap = "min-w-0 max-w-full break-all";

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

function parseBucket(value: unknown): Bucket {
  if (typeof value !== "object" || value === null) {
    throw new Error(copy("ui.buckets.are.unavailable"));
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error(copy("ui.buckets.are.unavailable"));
  }
  const localAliases = parseAliases(row.localAliases, "local");
  if (Array.isArray(row.keys)) {
    for (const value of row.keys) {
      if (typeof value !== "object" || value === null) continue;
      const key = value as Record<string, unknown>;
      if (typeof key.accessKeyId !== "string") continue;
      for (const alias of parseAliases(key.bucketLocalAliases, "local")) {
        const index = localAliases.findIndex((listed) => listed.scope === "local"
          && listed.name === alias.name
          && (listed.accessKeyId === null || listed.accessKeyId === key.accessKeyId));
        const detailed: Alias = { scope: "local", name: alias.name, accessKeyId: key.accessKeyId };
        if (index < 0) localAliases.push(detailed);
        else localAliases[index] = detailed;
      }
    }
  }
  return {
    id: row.id,
    aliases: [...parseAliases(row.globalAliases, "global"), ...localAliases],
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
    throw new Error(copy("ui.buckets.are.unavailable"));
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(copy("ui.buckets.are.unavailable"));
  }
  const page = parsed as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.buckets.are.unavailable"));
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
    return fill(copy("ui.remove.global.alias"), { name: alias.name });
  }
  if (alias.accessKeyId === null) {
    return null;
  }
  return fill(copy("ui.remove.local.alias.for"), { name: alias.name, accessKeyId: alias.accessKeyId });
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
  return { message: copy("ui.buckets.are.unavailable"), code: null };
}

async function loadPage(offset: number): Promise<BucketPage> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(`/api/buckets?offset=${offset}&limit=${PAGE_LIMIT}`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new BucketListError(failure);
  }
  return parsePage(text);
}

async function loadBucket(id: string): Promise<Bucket> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(bucketUrl(id), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new BucketListError(failure);
  }
  const bucket = parseBucket(JSON.parse(quoteCountLiterals(text)) as unknown);
  if (bucket.id !== id) throw new Error(copy("ui.buckets.are.unavailable"));
  return bucket;
}

function objectUsage(bucket: Bucket): string | null {
  const used = bucket.objects;
  const quota = bucket.quotas?.maxObjects;
  if (used !== null && quota?.kind === "digits") {
    return fill(copy("ui.of.objects"), { used: used, text: quota.text });
  }
  if (used !== null && quota?.kind === "unset") {
    return fill(copy("ui.objects.object.quota.is.not.set"), { used: used });
  }
  if (used !== null) {
    return fill(copy("ui.objects"), { used: used });
  }
  if (quota?.kind === "digits") {
    return fill(copy("ui.object.quota"), { text: quota.text });
  }
  if (quota?.kind === "unset") {
    return copy("ui.object.quota.is.not.set");
  }
  return null;
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
  const quota = bucket.quotas?.maxSize;
  if (objects === null && bucket.bytes === null && quota === undefined) {
    return null;
  }
  return (
    <div className="grid gap-2">
      {objects ? <p>{objects}</p> : null}
      <dl className="grid gap-2">
        {bucket.bytes !== null ? <div>
          <dt className="ui-muted">{copy("ui.size")}</dt>
          <dd><CompactCapacityText digits={bucket.bytes} /></dd>
        </div> : null}
        {quota?.kind === "digits" ? <div>
          <dt className="ui-muted">{copy("ui.max.size")}</dt>
          <dd><CompactCapacityText digits={quota.text} /></dd>
        </div> : null}
      </dl>
      {quota?.kind === "unset" ? <p>{copy("ui.size.quota.is.not.set")}</p> : null}
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
    copy("ui.saved"),
  );
  return (
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        const size = fieldLiteral(maxSize);
        const objects = fieldLiteral(maxObjects);
        if (size === null || objects === null) {
          save.reset();
          setRejected(copy("ui.quota.whole.or.empty"));
          return;
        }
        save.mutate(`{"maxSize":${size},"maxObjects":${objects}}`);
      }}
    >
      <label className={`${wrap} ui-field`}>
        {copy("ui.max.size")}<TextField.Root size="2"
          aria-label={fill(copy("ui.max.size.for"), { bucketId: bucketId })}
          inputMode="numeric"
          autoComplete="off"
          value={maxSize}
          onChange={(event) => {
            setMaxSize(event.target.value);
          }}
        />
      </label>
      <label className={`${wrap} ui-field`}>
        {copy("ui.max.objects")}<TextField.Root size="2"
          aria-label={fill(copy("ui.max.objects.for"), { bucketId: bucketId })}
          inputMode="numeric"
          autoComplete="off"
          value={maxObjects}
          onChange={(event) => {
            setMaxObjects(event.target.value);
          }}
        />
      </label>
      {error ? <p className="ui-alert">{error}</p> : null}
      {quotaStatus ? <p>{quotaStatus}</p> : null}
      <Button size="2" variant="solid"
        className={wrap}
        type="submit"
        disabled={save.isPending}
        aria-label={save.isPending ? copy("ui.saving.quotas") : fill(copy("ui.save.quotas.for"), { bucketId: bucketId })}
      >
        {save.isPending ? copy("ui.saving.quotas") : copy("ui.save.quotas")}
      </Button>
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
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy("ui.edit.cors")}</Button>
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
  const [saved, setSaved] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    if (query.isSuccess && drafts === null) {
      const loaded = draftsFromCors(query.data);
      setDrafts(loaded);
      setSaved(corsBody(loaded));
    }
  }, [query.isSuccess, query.data, drafts]);
  const dirty = drafts !== null && (corsBody(drafts) !== saved || current !== null);
  useEffect(() => {
    setFormDirty(`cors:${bucketId}`, dirty);
    return () => setFormDirty(`cors:${bucketId}`, false);
  }, [bucketId, dirty]);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/cors`, { method: "PUT", body }),
    onSuccess: (_response, body) => {
      setSaved(body);
      setCurrent(null);
    },
  });
  if (query.isError) {
    return <p>{query.error instanceof Error ? query.error.message : copy("ui.cors.rules.are.unavailable")}</p>;
  }
  if (drafts === null) {
    return null;
  }
  const ready = drafts.every(ruleReady);
  const replaceRule = (index: number, rule: CorsDraft) => {
    setDrafts(drafts.map((item, itemIndex) => (itemIndex === index ? rule : item)));
  };
  return (
    <div className="ui-form">
      {drafts.map((rule, index) => (
        <div key={index} className="grid gap-2">
          {rule.preserved !== undefined ? (
            <p>{JSON.stringify(rule.preserved)}</p>
          ) : (
            CORS_FIELDS.map(([key, label]) => (
              <label key={label} className="ui-field">
                {translate(label)}
                <TextField.Root size="2"
                  value={rule[key]}
                  onChange={(event) => {
                    replaceRule(index, { ...rule, [key]: event.target.value });
                  }}
                />
              </label>
            ))
          )}
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              setDrafts(drafts.filter((_, itemIndex) => itemIndex !== index));
            }}
          >
            {copy("ui.remove.cors.rule")}</Button>
        </div>
      ))}
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setDrafts([...drafts, emptyCorsDraft()]);
        }}
      >
        {copy("ui.add.cors.rule")}</Button>
      <Button size="2" color="gray" variant="soft"
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
              setReviewError(error instanceof Error ? error.message : copy("ui.cors.rules.are.unavailable"));
            });
        }}
      >
        {copy("ui.review.cors")}</Button>
      {reviewError ? <p>{reviewError}</p> : null}
      {current !== null ? (
        <>
          <pre aria-label={copy("ui.current")}>{current}</pre>
          <pre aria-label={copy("ui.next")}>{nextCorsText(drafts)}</pre>
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              setCurrent(null);
            }}
          >
            {copy("ui.cancel")}</Button>
          <Button size="2" color="gray" variant="soft"
            type="button"
            disabled={save.isPending || !ready}
            onClick={() => {
              save.mutate(corsBody(drafts));
            }}
          >
            {copy("ui.save.cors")}</Button>
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
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy("ui.edit.lifecycle")}</Button>
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
  const [saved, setSaved] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => {
    if (query.isSuccess && drafts === null) {
      const loaded = draftsFromLifecycle(query.data);
      setDrafts(loaded);
      setSaved(lifecycleBody(loaded));
    }
  }, [query.isSuccess, query.data, drafts]);
  const dirty = drafts !== null && (lifecycleBody(drafts) !== saved || current !== null);
  useEffect(() => {
    setFormDirty(`lifecycle:${bucketId}`, dirty);
    return () => setFormDirty(`lifecycle:${bucketId}`, false);
  }, [bucketId, dirty]);
  const save = useMutation({
    mutationFn: (body: string) => api(`${bucketUrl(bucketId)}/lifecycle`, { method: "PUT", body }),
    onSuccess: (_response, body) => {
      setSaved(body);
      setCurrent(null);
    },
  });
  if (query.isError) {
    return (
      <p>{query.error instanceof Error ? query.error.message : copy("ui.lifecycle.rules.are.unavailable")}</p>
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
    <div className="ui-form">
      {drafts.map((rule, index) => (
        <div key={index} className="grid gap-2">
          {rule.preserved !== undefined ? (
            <p>{JSON.stringify(rule.preserved)}</p>
          ) : (
            LIFECYCLE_FIELDS.map(([key, label]) => (
              <label key={label} className="ui-field">
                {translate(label)}
                <TextField.Root size="2"
                  value={rule[key]}
                  onChange={(event) => {
                    replaceRule(index, { ...rule, [key]: event.target.value });
                  }}
                />
              </label>
            ))
          )}
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              setDrafts(drafts.filter((_, itemIndex) => itemIndex !== index));
            }}
          >
            {copy("ui.remove.lifecycle.rule")}</Button>
        </div>
      ))}
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setDrafts([...drafts, emptyLifecycleDraft()]);
        }}
      >
        {copy("ui.add.lifecycle.rule")}</Button>
      <Button size="2" color="gray" variant="soft"
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
                error instanceof Error ? error.message : copy("ui.lifecycle.rules.are.unavailable"),
              );
            });
        }}
      >
        {copy("ui.review.lifecycle")}</Button>
      {reviewError ? <p>{reviewError}</p> : null}
      {current !== null ? (
        <>
          <pre aria-label={copy("ui.current")}>{current}</pre>
          <pre aria-label={copy("ui.next")}>{nextLifecycleText(drafts)}</pre>
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              setCurrent(null);
            }}
          >
            {copy("ui.cancel")}</Button>
          <Button size="2" color="gray" variant="soft"
            type="button"
            disabled={save.isPending || !ready}
            onClick={() => {
              save.mutate(lifecycleBody(drafts));
            }}
          >
            {copy("ui.save.lifecycle")}</Button>
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

function uploadsDeletedFrom(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("uploadsDeleted" in body)) {
    return null;
  }
  const value = (body as { uploadsDeleted: unknown }).uploadsDeleted;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function IncompleteUploads({ bucketId }: { bucketId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy("ui.incomplete.uploads")}</Button>
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
        {query.error instanceof Error ? query.error.message : copy("ui.incomplete.uploads.are.unavailable")}
      </p>
    );
  }
  if (!query.isSuccess) {
    return null;
  }
  const secs = olderThanSecs(hours);
  const deleted = uploadsDeletedFrom(cleanup.data);
  return (
    <div className="ui-form">
      {uploadsFrom(query.data).map((upload) => (
        <p className={`${wrap} grid gap-1`} key={`${upload.key}:${upload.uploadId}`}>
          <span>{upload.key}</span>
          <span>{upload.uploadId}</span>
          <span>{upload.initiated}</span>
        </p>
      ))}
      <label className="ui-field">
        {copy("ui.older.than.hours")}<TextField.Root size="2"
          inputMode="numeric"
          value={hours}
          onChange={(event) => {
            setHours(event.target.value);
          }}
        />
      </label>
      <Button size="2" color="gray" variant="soft"
        type="button"
        disabled={secs === null || cleanup.isPending}
        onClick={() => {
          if (secs === null) {
            return;
          }
          cleanup.mutate(secs);
        }}
      >
        {copy("ui.clean.up")}</Button>
      {cleanup.error instanceof Error ? <p>{cleanup.error.message}</p> : null}
      {deleted !== null ? <p>{fill(copy("ui.cleaned.up"), { deleted: deleted })}</p> : null}
    </div>
  );
}

function CreateBucketForm({ onPendingChange, onCancel }: { onPendingChange: (pending: boolean) => void; onCancel: () => void }) {
  const client = useQueryClient();
  const [globalAlias, setGlobalAlias] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (alias: string) =>
      api("/api/buckets", { method: "POST", body: JSON.stringify(createBody(alias)) }),
    onMutate: () => {
      onPendingChange(true);
      setNote(null);
    },
    onSettled: () => onPendingChange(false),
    onSuccess: async () => {
      setGlobalAlias("");
      setNote(copy("ui.bucket.created"));
      // Invalidation reuses an initial fetch with no cached data; cancel its stale snapshot first.
      await client.cancelQueries({ queryKey: ["buckets"], exact: true });
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!create.isPending) create.mutate(globalAlias);
      }}
    >
      <label className="ui-field">
        <span className="text-sm">{copy("ui.global.alias")}</span>
        <TextField.Root size="2"
          value={globalAlias}
          onChange={(event) => {
            setGlobalAlias(event.target.value);
          }}
        />
      </label>
      {error ? <p className="ui-alert">{error}</p> : null}
      {note ? <p>{note}</p> : null}
      <div className="ui-actions">
        <Button size="2" color="gray" variant="soft" type="button" disabled={create.isPending} onClick={onCancel}>{copy("ui.cancel")}</Button>
        <Button size="2" variant="solid"
          type="submit"
          disabled={create.isPending}
        >
          {create.isPending ? copy("ui.creating.bucket") : copy("ui.create.bucket")}
        </Button>
      </div>
    </form>
  );
}

function AliasControls({ bucketId }: { bucketId: string }) {
  const [open, setOpen] = useState(false);
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
      setNote(copy("ui.alias.added"));
      await client.invalidateQueries({ queryKey: ["buckets"] });
    },
  });
  const error = add.error instanceof Error ? add.error.message : null;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!add.isPending) setOpen(next); }}>
      <Dialog.Trigger><Button size="2" color="gray" variant="soft">{copy("ui.add.alias")}</Button></Dialog.Trigger>
      <Dialog.Content maxWidth="480px" aria-busy={add.isPending}
        onEscapeKeyDown={(event) => { if (add.isPending) event.preventDefault(); }}
        onInteractOutside={(event) => { if (add.isPending) event.preventDefault(); }}>
        <Dialog.Title>{copy("ui.add.alias")}</Dialog.Title>
        <Dialog.Description>{bucketId}</Dialog.Description>
        <form
          className="ui-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!add.isPending) add.mutate(draftBody(draft));
          }}
        >
          <RadioGroup.Root value={draft.scope} onValueChange={(scope) => setDraft((current) => ({ ...current, scope: scope as AliasDraft["scope"] }))} disabled={add.isPending}>
            <RadioGroup.Item value="global" aria-label={fill(copy("ui.global.for"), { bucketId })}>{copy("ui.global")}</RadioGroup.Item>
            <RadioGroup.Item value="local" aria-label={fill(copy("ui.local.for"), { bucketId })}>{copy("ui.local")}</RadioGroup.Item>
          </RadioGroup.Root>
          {draft.scope === "global" ? (
            <label className={`${wrap} ui-field`}>
              {copy("ui.global.alias")}<TextField.Root size="2"
                aria-label={fill(copy("ui.global.alias.for"), { bucketId: bucketId })}
                value={draft.globalAlias}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, globalAlias: event.target.value }));
                }}
              />
            </label>
          ) : (
            <>
              <label className={`${wrap} ui-field`}>
                {copy("ui.local.alias")}<TextField.Root size="2"
                  aria-label={fill(copy("ui.local.alias.for"), { bucketId: bucketId })}
                  value={draft.localAlias}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, localAlias: event.target.value }));
                  }}
                />
              </label>
              <label className={`${wrap} ui-field`}>
                {copy("ui.access.key")}<TextField.Root size="2"
                  aria-label={fill(copy("ui.access.key.for"), { bucketId: bucketId })}
                  value={draft.accessKeyId}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, accessKeyId: event.target.value }));
                  }}
                />
              </label>
            </>
          )}
          {error ? <p className="ui-alert">{error}</p> : null}
          {note ? <p>{note}</p> : null}
          <div className="ui-actions">
            <Button size="2" color="gray" variant="soft" type="button" disabled={add.isPending} onClick={() => setOpen(false)}>{copy("ui.cancel")}</Button>
            <Button size="2" variant="solid"
              className={wrap}
              type="submit"
              disabled={add.isPending}
              aria-label={add.isPending ? copy("ui.adding.alias") : fill(copy("ui.add.alias.to"), { bucketId: bucketId })}
            >
              {add.isPending ? copy("ui.adding.alias") : copy("ui.add.alias")}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
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
      <Button size="2" color="gray" variant="soft"
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          remove.mutate(body);
        }}
      >
        {remove.isPending ? copy("ui.removing.alias") : label}
      </Button>
      {error ? <p className="ui-alert">{error}</p> : null}
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <Dialog.Content maxWidth="480px" aria-busy={pending}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener?.isConnected) opener.focus(); }}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
        <Dialog.Title>{fill(copy("ui.delete.bucket"), { bucketId })}</Dialog.Title>
        <Dialog.Description>{fill(copy("ui.this.permanently.deletes.bucket.and.its.aliases.garage"), { bucketId })}</Dialog.Description>
        {error ? <p className="ui-alert">{error}</p> : null}
        <div className="ui-actions">
          <Button ref={cancelRef} size="2" color="gray" variant="soft" disabled={pending} onClick={onCancel}>{copy("ui.cancel")}</Button>
          <Button size="2" color="red" disabled={pending} onClick={() => { if (!pending) onConfirm(); }}>{copy(pending ? "ui.deleting.bucket" : "ui.delete.bucket.2")}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
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
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
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
      setNotice(copy("ui.bucket.deleted"));
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
  const addressedBucket = useQuery({
    queryKey: ["buckets", "detail", bucketDetail?.id],
    queryFn: bucketDetail === null ? undefined : () => loadBucket(bucketDetail.id),
    enabled: bucketDetail !== null && ["settings", "overview"].includes(bucketDetail.tab),
    initialData: () => rows.find((bucket) => bucket.id === bucketDetail?.id),
    staleTime: 30_000,
  });
  const openedBucket = addressedBucket.data ?? rows.find((bucket) => bucket.id === bucketDetail?.id);
  const detailFailure = addressedBucket.isError ? bucketListFailure(addressedBucket.error) : null;

  return (
    <section className="ui-page" aria-label={copy("nav.buckets")} aria-busy={view.busy}>
      {listing ? <header className="ui-page-header">
        <h2>{copy("nav.buckets")}</h2>
        {listing && canManage ? <Dialog.Root open={creating} onOpenChange={(open) => { if (!createPending) setCreating(open); }}>
          <Dialog.Trigger><Button size="2" type="button">{copy("common.create")}</Button></Dialog.Trigger>
          <Dialog.Content maxWidth="480px" aria-busy={createPending} aria-describedby={undefined}
            onEscapeKeyDown={(event) => { if (createPending) event.preventDefault(); }}
            onInteractOutside={(event) => { if (createPending) event.preventDefault(); }}>
            <Dialog.Title>{copy("ui.create.bucket")}</Dialog.Title>
            <CreateBucketForm onPendingChange={setCreatePending} onCancel={() => setCreating(false)} />
          </Dialog.Content>
        </Dialog.Root> : null}
      </header> : null}
      {bucketDetail ? (
        <DetailTabs
          key={bucketDetail.id}
          title={openedBucket?.aliases[0]?.name || copy("ui.bucket")}
          identity={<ResourceIdentity id={bucketDetail.id} />}
          label={fill(copy("ui.bucket.2"), { id: bucketDetail.id })}
          tabs={bucketTabs()}
          selected={bucketDetail.tab}
          hrefFor={(tab) => hashForDetail({ resource: "bucket", id: bucketDetail.id, tab })}
          onSelect={(tab) => {
            goHash(hashForDetail({ resource: "bucket", id: bucketDetail.id, tab }));
          }}
        >
          {["settings", "overview"].includes(bucketDetail.tab) && addressedBucket.isPending ? <div className="ui-panel" role="status" aria-label={copy("ui.loading.buckets")}>{copy("ui.loading.buckets")}</div> : null}
          {["settings", "overview"].includes(bucketDetail.tab) && detailFailure && !isGarageDown(detailFailure) ? <div className="ui-alert">
            <p>{detailFailure.message}</p>{detailFailure.code ? <p>{detailFailure.code}</p> : null}
            <Button size="2" color="gray" variant="soft" onClick={() => { void addressedBucket.refetch(); }}>{copy("ui.retry")}</Button>
          </div> : null}
          {bucketDetail.tab === "objects" ? (
            <Objects
              key={bucketDetail.id}
              embedded
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
          {bucketDetail.tab === "overview" && openedBucket ? <div className="ui-panel"><UsageText bucket={openedBucket} />
            {openedBucket.aliases.map((alias, index) => <p key={index}>{alias.name}</p>)}
          </div> : null}
          {bucketDetail.tab === "settings" && openedBucket ? <div className="ui-settings">
            <SettingsSection title={translate("General")}>
              <UsageText bucket={openedBucket} />
            </SettingsSection>
            <SettingsSection title={copy("ui.aliases")}>
              {openedBucket.aliases.map((alias, index) => <div className="ui-actions ui-bucket-alias" key={index}>
                <span>{alias.name}</span>
                {canManage ? <RemoveAliasButton bucketId={openedBucket.id} alias={alias} /> : null}
              </div>)}
              {canManage ? <AliasControls bucketId={openedBucket.id} /> : null}
            </SettingsSection>
            {canManage && openedBucket.quotas ? <SettingsSection title={translate("Quotas")}>
              <QuotaEditor bucketId={openedBucket.id} quotas={openedBucket.quotas} />
            </SettingsSection> : null}
            <SettingsSection title={translate("CORS")}>
              {canManage ? <CorsEditor bucketId={openedBucket.id} /> : <CorsSummary bucketId={openedBucket.id} />}
            </SettingsSection>
            <SettingsSection title={translate("Lifecycle")}>
              {canManage ? <LifecycleEditor bucketId={openedBucket.id} /> : <LifecycleSummary bucketId={openedBucket.id} />}
            </SettingsSection>
            {canManage ? <>
              <SettingsSection title={copy("ui.incomplete.uploads")}><IncompleteUploads bucketId={openedBucket.id} /></SettingsSection>
              <SettingsSection title={translate("Danger zone")} danger>
                <Button size="2" color="red" type="button" aria-label={fill(copy("ui.delete"), { id: openedBucket.id })} onClick={() => { removeBucket.reset(); setDeleteId(openedBucket.id); }}>{copy("ui.delete.2")}</Button>
              </SettingsSection>
            </> : null}
          </div> : null}
        </DetailTabs>
      ) : null}
      {bucketDetail === null && view.loading ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.buckets")}>{copy("ui.loading.buckets")}</div>
      ) : null}
      {bucketDetail === null && view.refreshing ? <p>{copy("ui.refreshing.buckets")}</p> : null}
      {bucketDetail === null && view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              void list.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {notice ? <p>{notice}</p> : null}
      {listing ? (
        <div className="ui-toolbar ui-resource-filters">
          <label className="ui-field">
            {copy("ui.filter.buckets")}<TextField.Root size="2"
              value={query.filter}
              onChange={(event) => {
                const next = { filter: event.target.value, sort: query.sort };
                setQuery(next);
                writeBucketQuery(next);
              }}
            />
          </label>
          <label className="ui-field">
            {copy("ui.sort.buckets")}<Select.Root value={query.sort} onValueChange={(value) => {
              const next = { filter: query.filter, sort: bucketSortFrom(value) };
              setQuery(next); writeBucketQuery(next);
            }}>
              <Select.Trigger aria-label={copy("ui.sort.buckets")} />
              <Select.Content>
                <Select.Item value="id">Id</Select.Item>
                <Select.Item value="alias">{copy("ui.alias")}</Select.Item>
                <Select.Item value="created">{copy("ui.created")}</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>
          <details className="ui-filter-help"><summary>{copy("ui.only.loaded.rows")}</summary><p className="ui-muted">{copy("ui.default.order.is.id")}</p></details>
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
            ? copy("ui.there.are.no.buckets.create.the.first.bucket")
            : copy("ui.there.are.no.buckets")}
        </p>
      ) : null}
      {listing && list.data && shown.length > 0 ? (
        <div className="ui-table-container min-w-0" role="region" aria-label={copy("ui.bucket")} tabIndex={0}>
          <Table.Root className="ui-table ui-table-records ui-bucket-list">
            <Table.Header><Table.Row>
              <Table.ColumnHeaderCell>{copy("ui.bucket")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{copy("ui.usage")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{copy("ui.actions")}</Table.ColumnHeaderCell>
            </Table.Row></Table.Header>
            <Table.Body>{shown.map((bucket, index) => (
              <Table.Row key={`${bucket.id}-${index}`} role="row">
                <DataCell kind="identity" label={copy("ui.bucket")}>
                  <a className="ui-resource-name text-[var(--accent)]" title={bucket.id} aria-label={`${bucket.aliases[0]?.name || copy("ui.bucket")} (${bucket.id})`}
                    href={hashForDetail({ resource: "bucket", id: bucket.id, tab: "overview" })}
                    onClick={(event) => { event.preventDefault(); goHash(hashForDetail({ resource: "bucket", id: bucket.id, tab: "overview" })); }}>
                    {bucket.aliases[0]?.name || copy("ui.bucket")}
                  </a>
                  {bucket.aliases.slice(1).map((alias, aliasIndex) => <span key={aliasIndex}> · <span>{alias.name}</span></span>)}
                  <ResourceIdentity id={bucket.id} compact />
                </DataCell>
                <DataCell label={copy("ui.usage")} className="ui-bucket-usage-cell">
                  <div className="ui-bucket-usage-desktop"><UsageText bucket={bucket} /></div>
                  {objectUsage(bucket) !== null || bucket.bytes !== null || bucket.quotas?.maxSize !== undefined ? <details className="ui-bucket-usage-mobile">
                    <summary><span>{copy("ui.usage")}</span>{bucket.objects !== null ? <span>{fill(copy("ui.objects"), { used: bucket.objects })}</span> : null}{bucket.bytes !== null ? <span><CapacityText digits={bucket.bytes} /></span> : null}</summary>
                    <UsageText bucket={bucket} />
                  </details> : null}
                </DataCell>
                <DataCell kind="actions" className="ui-record-actions-wide" label={copy("ui.actions")}><div className="ui-actions">
                  <Button size="2" color="gray" variant="soft" type="button" aria-label={`${translate("Open objects")} (${bucket.id})`}
                    onClick={() => goHash(hashForObjects(bucket.id, ""))}>{translate("Open objects")}</Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger><Button size="2" color="gray" variant="soft" aria-label={`${copy("ui.actions")} ${bucket.id}`}>{copy("ui.actions")}</Button></DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item aria-label={fill(copy("ui.permissions.for"), { bucketId: bucket.id })}
                        onSelect={() => goHash(hashForDetail({ resource: "bucket", id: bucket.id, tab: "permissions" }))}>{copy("tab.permissions")}</DropdownMenu.Item>
                      <DropdownMenu.Item aria-label={`${copy(canManage ? "ui.edit" : "nav.settings")} ${bucket.id}`}
                        onSelect={() => goHash(hashForDetail({ resource: "bucket", id: bucket.id, tab: "settings" }))}>{copy(canManage ? "ui.edit" : "nav.settings")}</DropdownMenu.Item>
                      {canManage ? <DropdownMenu.Item color="red" aria-label={fill(copy("ui.delete"), { id: bucket.id })}
                        onSelect={() => { removeBucket.reset(); setDeleteId(bucket.id); }}>{copy("ui.delete.2")}</DropdownMenu.Item> : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div></DataCell>
              </Table.Row>
            ))}</Table.Body>
          </Table.Root>
        </div>
      ) : null}
      {listing && view.partial ? (
        <>
          <p>{copy("ui.more.buckets.are.available")}</p>
          <Button size="2" color="gray" variant="soft"
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {copy("ui.load.more")}</Button>
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
