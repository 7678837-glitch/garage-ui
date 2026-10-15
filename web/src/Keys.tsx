import { Button, Checkbox, Dialog, Select, Table, TextField } from "@radix-ui/themes";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, captureAuthGeneration, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { ConfirmDialog } from "./confirm";
import { SecretDialog } from "./SecretDialog";
import { DetailTabs } from "./DetailTabs";
import { detailAddressFromHash, hashForDetail, keyTabs, useLocationHash } from "./Nav";
import { releaseHash, savePhase, saveStatus, setFormDirty } from "./unsaved";
import { copy, fill, translate } from "./i18n";
import { DataCell, ResourceIdentity, SettingsSection } from "./ui";

type AccessKey = {
  id: string;
  name: string | null;
  createBucket: boolean | null;
  created: string | null;
};

type KeyPage = {
  items: AccessKey[];
  hasMore: boolean;
};

type SecretReveal = {
  keyId: string;
  secret: string;
};

// When the server omits limit, the window is 100. The next offset adds this page's row count.
const PAGE_LIMIT = 100;

function parseKey(value: unknown): AccessKey {
  if (typeof value !== "object" || value === null) {
    throw new Error(copy("ui.keys.are.unavailable"));
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error(copy("ui.keys.are.unavailable"));
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    createBucket: parseCreateBucket(row),
    created: typeof row.created === "string" && row.created.length > 0 ? row.created : null,
  };
}

// The list often omits permissions. null means unknown, and must not be shown as denied.
function parseCreateBucket(row: Record<string, unknown>): boolean | null {
  const permissions = row.permissions;
  if (typeof permissions === "object" && permissions !== null) {
    const value = (permissions as Record<string, unknown>).createBucket;
    if (typeof value === "boolean") {
      return value;
    }
  }
  return typeof row.createBucket === "boolean" ? row.createBucket : null;
}

function parsePage(body: unknown): KeyPage {
  if (typeof body !== "object" || body === null) {
    throw new Error(copy("ui.keys.are.unavailable"));
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.keys.are.unavailable"));
  }
  return {
    items: page.items.map(parseKey),
    hasMore: page.hasMore,
  };
}

function nextOffset(offset: number, page: KeyPage): number | undefined {
  if (!page.hasMore || page.items.length === 0) {
    return undefined;
  }
  return offset + page.items.length;
}

function keyUrl(id: string): string {
  return `/api/keys/${encodeURIComponent(id)}`;
}

type KeyBucket = {
  id: string;
  globalAliases: string[];
  localAliases: string[];
  owner: boolean;
  read: boolean;
  write: boolean;
};

function granted(value: unknown): boolean {
  return value === true;
}

function aliasList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      names.push(item);
    }
  }
  return names;
}

function parseKeyBucket(value: unknown): KeyBucket | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    return null;
  }
  const permissions = row.permissions;
  const bits =
    typeof permissions === "object" && permissions !== null
      ? (permissions as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    globalAliases: aliasList(row.globalAliases),
    localAliases: aliasList(row.localAliases),
    owner: granted(bits.owner),
    read: granted(bits.read),
    write: granted(bits.write),
  };
}

function parseKeyBuckets(payload: unknown): KeyBucket[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(copy("ui.key.buckets.are.unavailable"));
  }
  const buckets = (payload as Record<string, unknown>).buckets;
  if (!Array.isArray(buckets)) {
    throw new Error(copy("ui.key.buckets.are.unavailable"));
  }
  const rows: KeyBucket[] = [];
  for (const entry of buckets) {
    const bucket = parseKeyBucket(entry);
    if (bucket !== null) {
      rows.push(bucket);
    }
  }
  return rows;
}

function yesNo(flag: boolean): string {
  return flag ? copy("ui.yes") : copy("ui.no");
}

async function loadKeyBuckets(keyId: string): Promise<KeyBucket[]> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(keyUrl(keyId), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new KeyListError(failure);
  }
  return parseKeyBuckets(text ? (JSON.parse(text) as unknown) : undefined);
}

async function loadKey(id: string): Promise<AccessKey> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(keyUrl(id), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new KeyListError(failure);
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const key = parseKey({ ...body, id: body.id ?? body.accessKeyId });
  if (key.id !== id) throw new Error(copy("ui.keys.are.unavailable"));
  return key;
}

function KeyBuckets({ keyId }: { keyId: string }) {
  const buckets = useQuery({
    queryKey: ["key-buckets", keyId],
    queryFn: () => loadKeyBuckets(keyId),
  });
  const rows = buckets.data ?? [];
  const failure = buckets.isError ? keyListFailure(buckets.error) : null;
  return (
    <div role="region" aria-label={fill(copy("ui.buckets.for"), { keyId: keyId })}>
      {buckets.isPending ? (
        <div className="h-16 border border-line" role="status" aria-label={fill(copy("ui.loading.buckets.for"), { keyId: keyId })}>{fill(copy("ui.loading.buckets.for"), { keyId: keyId })}</div>
      ) : null}
      {failure && !isGarageDown(failure) ? (
        <>
          <p>{failure.message}</p>
          {failure.code ? <p>{failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void buckets.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {buckets.data && rows.length === 0 ? <p>{copy("ui.this.key.cannot.access.any.buckets")}</p> : null}
      {rows.length > 0 ? (
        <div className="ui-table-container" role="region" aria-label={copy("nav.buckets")} tabIndex={0}>
          <Table.Root className="ui-table-records"><Table.Header><Table.Row>
            <Table.ColumnHeaderCell scope="col">{copy("ui.bucket")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell scope="col">{copy("ui.aliases")}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">{copy("ui.owner.2")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell scope="col">{copy("ui.read.2")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell scope="col">{copy("ui.write.2")}</Table.ColumnHeaderCell>
          </Table.Row></Table.Header><Table.Body>{rows.map((bucket, index) => (
            <Table.Row key={`${bucket.id}-${index}`} role="row" aria-label={bucket.id}>
              <DataCell label={copy("ui.bucket")} kind="identity" className="ui-identifier">{bucket.id}</DataCell><DataCell label={copy("ui.aliases")}>{[...bucket.globalAliases, ...bucket.localAliases].map((alias, aliasIndex) => <span className="mr-2" key={aliasIndex}>{alias}</span>)}</DataCell>
              <DataCell label={copy("ui.owner.2")}>{fill(copy("ui.owner"), { flag: yesNo(bucket.owner) })}</DataCell>
              <DataCell label={copy("ui.read.2")}>{fill(copy("ui.read"), { flag: yesNo(bucket.read) })}</DataCell><DataCell label={copy("ui.write.2")}>{fill(copy("ui.write"), { flag: yesNo(bucket.write) })}</DataCell>
            </Table.Row>
          ))}</Table.Body></Table.Root>
        </div>
      ) : null}
    </div>
  );
}

function secretFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const secret = (body as Record<string, unknown>).secretAccessKey;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

function createdKeyId(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) {
    return fallback;
  }
  const row = body as Record<string, unknown>;
  if (typeof row.accessKeyId === "string" && row.accessKeyId.length > 0) {
    return row.accessKeyId;
  }
  if (typeof row.id === "string" && row.id.length > 0) {
    return row.id;
  }
  return fallback;
}

type KeyListFailure = {
  message: string;
  code: string | null;
};

class KeyListError extends Error {
  readonly code: string | null;

  constructor(failure: KeyListFailure) {
    super(failure.message);
    this.name = "KeyListError";
    this.code = failure.code;
  }
}

// api() keeps only the message on Error. The key list also shows the code from the body, so this reads the response.
function failureFrom(text: string, status: number): KeyListFailure {
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

function keyListFailure(error: unknown): KeyListFailure {
  if (error instanceof KeyListError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null };
  }
  return { message: copy("ui.keys.are.unavailable"), code: null };
}

async function loadPage(offset: number): Promise<KeyPage> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(`/api/keys?offset=${offset}&limit=${PAGE_LIMIT}`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new KeyListError(failure);
  }
  return parsePage(text ? (JSON.parse(text) as unknown) : undefined);
}

function CreateKeyForm({ open, onOpenChange, onSecret }: { open: boolean; onOpenChange: (open: boolean) => void; onSecret: (reveal: SecretReveal, trigger: HTMLButtonElement | null) => void }) {
  const client = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (next: string) => {
      const body = await api<unknown>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: next }),
      });
      const secret = secretFrom(body);
      if (secret) {
        onOpenChange(false);
        onSecret({ keyId: createdKeyId(body, next), secret }, triggerRef.current);
      }
    },
    onMutate: () => {
      setNote(null);
    },
    onSuccess: async () => {
      setName("");
      setNote(copy("ui.key.created"));
      await client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!create.isPending) onOpenChange(next); }}>
      <Dialog.Trigger><Button ref={triggerRef} size="2" variant="solid" color="orange" type="button">{copy("common.create")}</Button></Dialog.Trigger>
      <Dialog.Content maxWidth="480px" aria-describedby={undefined} onEscapeKeyDown={(event) => { if (create.isPending) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title>{copy("ui.create.key")}</Dialog.Title>
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!create.isPending) create.mutate(name);
      }}
    >
      <label className="ui-field">
        <span className="text-sm">{copy("ui.key.name")}</span>
        <TextField.Root size="2"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      {error ? <p className="ui-alert">{error}</p> : null}
      {note ? <p>{note}</p> : null}
      <Button size="2" variant="solid" color="orange"
        type="submit"
        disabled={create.isPending}
      >
        {create.isPending ? copy("ui.creating.key") : copy("ui.create.key")}
      </Button>
      <Button size="2" variant="soft" color="gray" type="button" disabled={create.isPending} onClick={() => { setName(""); create.reset(); onOpenChange(false); }}>{copy("ui.cancel")}</Button>
    </form>
    </Dialog.Content></Dialog.Root>
  );
}

function RenameKey({ id, name, allowed }: { id: string; name: string | null; allowed?: boolean | null }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [permissionPending, setPermissionPending] = useState(false);
  const currentName = name ?? "";
  const [baseline, setBaseline] = useState(currentName);
  const [draft, setDraft] = useState(currentName);
  const nameDirty = draft !== baseline;
  useEffect(() => {
    setFormDirty(`rename:${id}`, nameDirty);
    return () => setFormDirty(`rename:${id}`, false);
  }, [id, nameDirty]);
  const rename = useMutation({
    mutationFn: async (next: string) => {
      await api(keyUrl(id), { method: "PATCH", body: JSON.stringify({ name: next }) });
    },
    onSuccess: async (_result, next) => {
      setBaseline(next);
      await client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const error = rename.error instanceof Error ? rename.error.message : null;
  const renameStatus = saveStatus(
    savePhase(rename.isPending, rename.isError, rename.isSuccess),
    nameDirty,
    copy("ui.key.renamed"),
  );
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!rename.isPending && !permissionPending) setOpen(next); }}>
      <Dialog.Trigger><Button size="2" variant="soft" color="gray" type="button" aria-label={`${copy("ui.actions")} (${id})`}>{copy("ui.actions")}</Button></Dialog.Trigger>
      <Dialog.Content maxWidth="480px" aria-describedby={undefined} onEscapeKeyDown={(event) => { if (rename.isPending || permissionPending) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title>{copy("ui.name")}</Dialog.Title>
      <p className="ui-identifier">{id}</p>
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!rename.isPending && !permissionPending) rename.mutate(draft);
      }}
    >
      <label className="ui-field">
        <span className="text-sm">{copy("ui.name")}</span>
        <TextField.Root size="2"
          aria-label={fill(copy("ui.name.for"), { id })}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </label>
      {error ? <p className="ui-alert">{error}</p> : null}
      {renameStatus ? <p>{renameStatus}</p> : null}
      <Button size="2" variant="solid" color="orange"
        type="submit"
        aria-label={`${translate("Save name")} (${id})`}
        disabled={rename.isPending}
      >
        {translate("Save name")}
      </Button>
    </form>
      {allowed !== undefined ? <CreateBucketSwitch id={id} allowed={allowed} onPendingChange={setPermissionPending} /> : null}
      <Button size="2" variant="soft" color="gray" type="button" disabled={rename.isPending || permissionPending} onClick={() => setOpen(false)}>{translate("Close")}</Button>
    </Dialog.Content></Dialog.Root>
  );
}

function CreateBucketSwitch({ id, allowed, onPendingChange }: { id: string; allowed: boolean | null; onPendingChange?: (pending: boolean) => void }) {
  const client = useQueryClient();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const shown = chosen ?? allowed;
  const change = useMutation({
    mutationFn: async (next: boolean) => {
      await api(keyUrl(id), {
        method: "PATCH",
        body: JSON.stringify({ createBucket: next }),
      });
    },
    onSuccess: async (_result, next) => {
      setChosen(next);
      await client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  useEffect(() => { onPendingChange?.(change.isPending); }, [change.isPending, onPendingChange]);
  const error = change.error instanceof Error ? change.error.message : null;
  return (
    <div>
      <label className="ui-checkbox-field">
        <Checkbox size="2"

          aria-label={`${translate("Allow bucket creation")} (${id})`}
          checked={shown === null ? "indeterminate" : shown}
          disabled={change.isPending}
          onCheckedChange={(checked) => {
            change.mutate((checked === true));
          }}
        />
        {translate("Allow bucket creation")}</label>
      <p className="ui-muted">{translate("Saved automatically")}</p>
      {change.isPending ? <p>{copy("ui.saving")}</p> : null}
      {error ? <p className="ui-alert">{error}</p> : null}
    </div>
  );
}

type KeySort = "id" | "name" | "created";

type KeyQuery = {
  filter: string;
  sort: KeySort;
};

function keySortFrom(value: string | null): KeySort {
  if (value === "name" || value === "created") {
    return value;
  }
  return "id";
}

function readKeyQuery(): KeyQuery {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: params.get("keys") ?? "",
    sort: keySortFrom(params.get("keysSort")),
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

function writeKeyQuery(query: KeyQuery) {
  const params = new URLSearchParams(window.location.search);
  if (query.filter.length > 0) {
    params.set("keys", query.filter);
  } else {
    params.delete("keys");
  }
  if (query.sort === "id") {
    params.delete("keysSort");
  } else {
    params.set("keysSort", query.sort);
  }
  replaceListQuery(params);
}

function keyMatches(accessKey: AccessKey, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  const needle = filter.toLowerCase();
  if (accessKey.id.toLowerCase().includes(needle)) {
    return true;
  }
  return accessKey.name !== null && accessKey.name.toLowerCase().includes(needle);
}

function orderedKeys(rows: AccessKey[], sort: KeySort): AccessKey[] {
  switch (sort) {
    case "id":
      return rows;
    case "name":
      return [...rows].sort((left, right) => {
        const a = (left.name ?? "").toLowerCase();
        const b = (right.name ?? "").toLowerCase();
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

export function Keys({ canManage = false }: { canManage?: boolean }) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [secretId, setSecretId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<SecretReveal | null>(null);
  const secretTrigger = useRef<HTMLButtonElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hash, assignHash] = useLocationHash();
  const goHash = (next: string) => {
    if (!releaseHash(next)) {
      return;
    }
    assignHash(next);
  };
  const list = useInfiniteQuery({
    queryKey: ["keys"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => loadPage(pageParam),
    getNextPageParam: (page, _pages, offset) => nextOffset(offset, page),
  });
  const viewSecret = useMutation({
    mutationFn: async (id: string) => {
      const body = await api<unknown>(`${keyUrl(id)}/secret`, {
        method: "POST",
        headers: { "X-Confirm": "yes" },
      });
      const secret = secretFrom(body);
      if (!secret) {
        throw new Error(copy("ui.secret.is.unavailable"));
      }
      setReveal({ keyId: id, secret });
    },
  });
  const removeKey = useMutation({
    mutationFn: async (id: string) => {
      await api(keyUrl(id), { method: "DELETE" });
    },
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: async () => {
      setDeleteId(null);
      setNotice(copy("ui.key.deleted"));
      await client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const [query, setQuery] = useState(readKeyQuery);
  useEffect(() => {
    const sync = () => setQuery(readKeyQuery());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedKeys(
    rows.filter((accessKey) => keyMatches(accessKey, query.filter)),
    query.sort,
  );
  const view = {
    busy: list.isPending,
    refreshing: rows.length > 0 && list.isFetching && !list.isPending,
    empty: Boolean(list.data) && rows.length === 0,
    failure: list.isError ? keyListFailure(list.error) : null,
    partial: list.hasNextPage,
  };
  const deleteError = removeKey.error instanceof Error ? removeKey.error.message : null;
  const viewError = viewSecret.error instanceof Error ? viewSecret.error.message : null;
  const detail = detailAddressFromHash(hash);
  const keyDetail = detail?.resource === "key" ? detail : null;
  const addressedKey = useQuery({
    queryKey: ["keys", "detail", keyDetail?.id],
    queryFn: keyDetail === null ? undefined : () => loadKey(keyDetail.id),
    enabled: keyDetail !== null && ["settings", "overview"].includes(keyDetail.tab),
    initialData: () => rows.find((accessKey) => accessKey.id === keyDetail?.id),
    staleTime: 30_000,
  });
  const openedKey = addressedKey.data ?? rows.find((accessKey) => accessKey.id === keyDetail?.id);
  const detailFailure = addressedKey.isError ? keyListFailure(addressedKey.error) : null;

  return (
    <section className="ui-page" aria-label={copy("nav.keys")} aria-busy={view.busy}>
      {keyDetail === null ? <header className="ui-page-header">
        <h2>{copy("nav.keys")}</h2>
        {canManage ? <CreateKeyForm open={creating} onOpenChange={setCreating} onSecret={(secret, trigger) => { secretTrigger.current = trigger; setNotice(copy("ui.key.created")); setReveal(secret); }} /> : null}
      </header> : null}
      {keyDetail ? (
        <DetailTabs
          label={fill(copy("ui.key"), { id: keyDetail.id })}
          title={openedKey?.name || copy("ui.key.2")}
          identity={<ResourceIdentity id={keyDetail.id} />}
          tabs={keyTabs()}
          selected={keyDetail.tab}
          hrefFor={(tab) => hashForDetail({ resource: "key", id: keyDetail.id, tab })}
          onSelect={(tab) => {
            goHash(hashForDetail({ resource: "key", id: keyDetail.id, tab }));
          }}
        >
          {["settings", "overview"].includes(keyDetail.tab) && addressedKey.isPending ? <div className="ui-panel" role="status" aria-label={copy("ui.loading.keys")}>{copy("ui.loading.keys")}</div> : null}
          {["settings", "overview"].includes(keyDetail.tab) && detailFailure && !isGarageDown(detailFailure) ? <div className="ui-alert">
            <p>{detailFailure.message}</p>{detailFailure.code ? <p>{detailFailure.code}</p> : null}
            <Button size="2" variant="soft" color="gray" onClick={() => { void addressedKey.refetch(); }}>{copy("ui.retry")}</Button>
          </div> : null}
          {keyDetail.tab === "overview" && openedKey ? <div className="ui-panel">{openedKey.created ? <p>{openedKey.created}</p> : null}</div> : null}
          {keyDetail.tab === "buckets" ? <KeyBuckets keyId={keyDetail.id} /> : null}
          {keyDetail.tab === "settings" && openedKey && canManage ? (
            <div className="ui-settings">
              <SettingsSection title={translate("General")}>
                <RenameKey key={openedKey.id} id={openedKey.id} name={openedKey.name} />
              </SettingsSection>
              <SettingsSection title={copy("tab.permissions")}>
                <CreateBucketSwitch key={openedKey.id} id={openedKey.id} allowed={openedKey.createBucket} />
              </SettingsSection>
              <SettingsSection title={translate("Credentials")}>
                <Button size="2" variant="soft" color="gray" type="button" aria-label={fill(copy("ui.view.secret.for"), { id: openedKey.id })} disabled={viewSecret.isPending} onClick={(event) => { secretTrigger.current = event.currentTarget; viewSecret.reset(); setSecretId(openedKey.id); }}>{copy("ui.view.secret")}</Button>
                {viewError ? <p className="ui-alert">{viewError}</p> : null}
              </SettingsSection>
              <SettingsSection title={translate("Danger zone")} danger>
                <Button size="2" variant="solid" color="red" type="button" aria-label={`${translate("Delete key")} (${openedKey.id})`} onClick={() => { removeKey.reset(); setDeleteId(openedKey.id); }}>{translate("Delete key")}</Button>
              </SettingsSection>
            </div>
          ) : null}
        </DetailTabs>
      ) : null}
      {keyDetail === null && view.busy ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.keys")}>{copy("ui.loading.keys")}</div>
      ) : null}
      {keyDetail === null && view.refreshing ? <p>{copy("ui.refreshing.keys")}</p> : null}
      {keyDetail === null && view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void list.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {notice ? <p>{notice}</p> : null}
      {keyDetail === null ? (
      <div className="ui-toolbar ui-resource-filters">
        <label className="ui-field">
          {copy("ui.filter.keys")}<TextField.Root size="2"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeKeyQuery(next);
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.sort.keys")}<Select.Root size="2"
            value={query.sort}
            onValueChange={(value) => {
              const next = {
                filter: query.filter,
                sort: keySortFrom(value),
              };
              setQuery(next);
              writeKeyQuery(next);
            }}
          ><Select.Trigger aria-label={copy("ui.sort.keys")} /><Select.Content>
            <Select.Item value="id">Id</Select.Item>
            <Select.Item value="name">{copy("ui.name")}</Select.Item>
            <Select.Item value="created">{copy("ui.created")}</Select.Item>
          </Select.Content></Select.Root>
        </label>
        <details className="ui-filter-help"><summary>{copy("ui.only.loaded.rows")}</summary><p className="ui-muted">{copy("ui.default.order.is.id")}</p></details>
      </div>
      ) : null}
      {keyDetail === null && view.empty ? (
        <p>{canManage ? copy("ui.there.are.no.keys.create.the.first.key") : copy("ui.there.are.no.keys")}</p>
      ) : null}
      {keyDetail === null && list.data && shown.length > 0 ? (
        <div className="ui-table-container min-w-0" role="region" aria-label={copy("ui.key.2")} tabIndex={0}>
          <Table.Root className="ui-table-records ui-key-list">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.key.2")}</Table.ColumnHeaderCell>
                {canManage ? (
                  <Table.ColumnHeaderCell className="py-2 font-medium" scope="col">
                    {copy("ui.actions")}</Table.ColumnHeaderCell>
                ) : null}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.map((accessKey, index) => (
                <Table.Row key={`${accessKey.id}-${index}`} role="row">
                  <DataCell label={copy("ui.key.2")} kind="identity">{accessKey.name ? <strong className="block">{accessKey.name}</strong> : null}<a className="ui-identifier ui-button-quiet" title={accessKey.id} aria-label={accessKey.id.length > 24 ? `${accessKey.id.slice(0, 8)}…${accessKey.id.slice(-6)} (${accessKey.id})` : accessKey.id}
                    href={hashForDetail({ resource: "key", id: accessKey.id, tab: "overview" })}
                    onClick={(event) => { event.preventDefault(); goHash(hashForDetail({ resource: "key", id: accessKey.id, tab: "overview" })); }}>
                    {accessKey.id.length > 24 ? `${accessKey.id.slice(0, 8)}…${accessKey.id.slice(-6)}` : accessKey.id}
                  </a></DataCell>
                  {canManage ? (
                    <DataCell label={copy("ui.actions")} kind="actions" className="ui-record-actions-wide"><div className="ui-actions">
                      <Button size="2" variant="soft" color="gray"
                        type="button"
                        aria-label={viewSecret.isPending && viewSecret.variables === accessKey.id ? copy("ui.reading.secret") : `${copy("ui.show.secret")} (${accessKey.id})`}
                        disabled={viewSecret.isPending && viewSecret.variables === accessKey.id}
                        onClick={(event) => {
                          secretTrigger.current = event.currentTarget;
                          viewSecret.reset();
                          setSecretId(accessKey.id);
                        }}
                      >
                        {viewSecret.isPending && viewSecret.variables === accessKey.id
                          ? copy("ui.reading.secret")
                          : copy("ui.show.secret")}
                      </Button>
                      {viewSecret.variables === accessKey.id && viewError ? (
                        <p className="ui-alert">{viewError}</p>
                      ) : null}
                      <RenameKey id={accessKey.id} name={accessKey.name} allowed={accessKey.createBucket} />
                      <Button size="2" variant="solid" color="red" type="button" aria-label={fill(copy("ui.delete"), { id: accessKey.id })} onClick={() => { removeKey.reset(); setDeleteId(accessKey.id); }}>{copy("ui.delete.2")}</Button>
                    </div></DataCell>
                  ) : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </div>
      ) : null}
      {keyDetail === null && view.partial ? (
        <>
          <p>{copy("ui.more.keys.are.available")}</p>
          <Button size="2" variant="soft" color="gray"
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
        <ConfirmDialog
          action="delete-key"
          name={deleteId}
          pending={removeKey.isPending}
          consequence={fill(copy("ui.this.permanently.deletes.key.clients.that.use.this"), { deleteId: deleteId, error: deleteError ? ` ${deleteError}` : "" })}
          onCancel={() => {
            setDeleteId(null);
            removeKey.reset();
          }}
          onConfirm={() => {
            if (removeKey.isPending) {
              return;
            }
            removeKey.mutate(deleteId);
          }}
        />
      ) : null}
      {secretId !== null ? (
        <ConfirmDialog
          action="reveal-secret"
          name={secretId}
          consequence={copy("ui.viewing.a.secret.is.audited.confirm.to.show")}
          onCancel={() => setSecretId(null)}
          onConfirm={() => {
            viewSecret.mutate(secretId);
            setSecretId(null);
          }}
        />
      ) : null}
      {reveal !== null ? (
        <SecretDialog
          secret={reveal.secret}
          title={fill(copy("ui.secret.for"), { keyId: reveal.keyId })}
          label={copy("ui.secret.access.key")}
          description={copy("ui.closing.this.dialog.removes.the.secret")}
          returnFocus={secretTrigger.current}
          onClose={() => {
            setReveal(null);
            viewSecret.reset();
          }}
        />
      ) : null}
    </section>
  );
}
