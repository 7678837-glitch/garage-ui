import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { isGarageDown } from "./garageDown";
import { ConfirmDialog } from "./confirm";
import { savePhase, saveStatus, setFormDirty } from "./unsaved";

type AccessKey = {
  id: string;
  name: string | null;
  createBucket: boolean | null;
};

type KeyPage = {
  items: AccessKey[];
  hasMore: boolean;
};

type SecretReveal = {
  keyId: string;
  secret: string;
};

// 服务端未传 limit 时窗口是 100。下一页 offset 用本页条数。
const PAGE_LIMIT = 100;

function parseKey(value: unknown): AccessKey {
  if (typeof value !== "object" || value === null) {
    throw new Error("Keys are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error("Keys are unavailable");
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    createBucket: parseCreateBucket(row),
  };
}

// 列表经常不带 permissions。null 是未知，不能显示成未授权。
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
    throw new Error("Keys are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Keys are unavailable");
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

// api() 只把 message 放进 Error。密钥列表还要显示 body 里的 code，所以这里自己读响应。
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
  return { message: "Keys are unavailable", code: null };
}

async function loadPage(offset: number): Promise<KeyPage> {
  const response = await fetch(`/api/keys?offset=${offset}&limit=${PAGE_LIMIT}`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new KeyListError(failureFrom(text, response.status));
  }
  return parsePage(text ? (JSON.parse(text) as unknown) : undefined);
}

async function copySecret(secret: string): Promise<"copied" | "select"> {
  const clipboard = navigator.clipboard;
  if (!window.isSecureContext || typeof clipboard?.writeText !== "function") {
    return "select";
  }
  try {
    await clipboard.writeText(secret);
    return "copied";
  } catch {
    return "select";
  }
}

function openDialog(dialog: HTMLDialogElement) {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) {
      dialog.showModal();
    }
    return;
  }
  dialog.setAttribute("open", "");
}

function CreateKeyForm({ onSecret }: { onSecret: (reveal: SecretReveal) => void }) {
  const client = useQueryClient();
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
        onSecret({ keyId: createdKeyId(body, next), secret });
      }
    },
    onMutate: () => {
      setNote(null);
    },
    onSuccess: async () => {
      setName("");
      setNote("Key created");
      await client.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <form
      className="grid max-w-sm gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(name);
      }}
    >
      <label className="block">
        <span className="text-sm">Key name</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {note ? <p>{note}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={create.isPending}
      >
        {create.isPending ? "Creating key" : "Create key"}
      </button>
    </form>
  );
}

function RenameKey({ id, name }: { id: string; name: string | null }) {
  const client = useQueryClient();
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
    "Key renamed",
  );
  return (
    <form
      className="mt-3 grid max-w-sm gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate(draft);
      }}
    >
      <label className="block">
        <span className="text-sm">Name for {id}</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {renameStatus ? <p>{renameStatus}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={rename.isPending}
      >
        {rename.isPending ? "Renaming key" : `Rename ${id}`}
      </button>
    </form>
  );
}

function CreateBucketSwitch({ id, allowed }: { id: string; allowed: boolean | null }) {
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
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
  useLayoutEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = shown === null;
    }
  }, [shown]);
  const error = change.error instanceof Error ? change.error.message : null;
  return (
    <div className="mt-3">
      <label className="text-sm">
        <input
          ref={inputRef}
          className="mr-2"
          type="checkbox"
          checked={shown === true}
          disabled={change.isPending}
          onChange={(event) => {
            change.mutate(event.target.checked);
          }}
        />
        Allow create bucket for {id}
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function SecretDialog({ reveal, onClose }: { reveal: SecretReveal; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    openDialog(dialog);
    copyRef.current?.focus();
  }, [reveal]);
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="key-secret-title"
      className="border border-ink bg-canvas p-4 text-ink"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <h3 id="key-secret-title" className="font-medium">
        Secret for {reveal.keyId}
      </h3>
      <p>This secret is shown once. Closing this dialog removes it from the page.</p>
      <label className="block">
        <span className="text-sm">Secret access key</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          readOnly
          autoComplete="off"
          type={visible ? "text" : "password"}
          value={reveal.secret}
        />
      </label>
      <button
        className="mr-2 border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setVisible(true);
        }}
      >
        Show secret
      </button>
      <button
        ref={copyRef}
        className="mr-2 border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          void copySecret(reveal.secret).then((result) => {
            if (result === "copied") {
              setFeedback("Copied");
              return;
            }
            setVisible(true);
            setFeedback("Select the secret and copy it");
          });
        }}
      >
        Copy secret
      </button>
      {feedback ? <p>{feedback}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="button"
        onClick={onClose}
      >
        I have saved it
      </button>
    </dialog>
  );
}

type KeySort = "id" | "name";

type KeyQuery = {
  filter: string;
  sort: KeySort;
};

function keySortFrom(value: string | null): KeySort {
  return value === "name" ? "name" : "id";
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
  if (query.sort === "name") {
    params.set("keysSort", "name");
  } else {
    params.delete("keysSort");
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
  if (sort === "id") {
    return rows;
  }
  return [...rows].sort((left, right) => {
    const a = (left.name ?? "").toLowerCase();
    const b = (right.name ?? "").toLowerCase();
    return a.localeCompare(b);
  });
}

export function Keys({ canManage = false }: { canManage?: boolean }) {
  const client = useQueryClient();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<SecretReveal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        throw new Error("Secret is unavailable");
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
      setNotice("Key deleted");
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

  return (
    <section className="grid min-w-0 gap-4" aria-label="Keys" aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">Keys</h2>
      {canManage ? <CreateKeyForm onSecret={setReveal} /> : null}
      {view.busy ? <div className="h-16 border border-line" aria-label="Loading keys" /> : null}
      {view.refreshing ? <p>Refreshing keys</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="border border-ink px-3 py-1 text-left"
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
      <div className="grid max-w-sm gap-3">
        <label className="block text-sm">
          Filter keys
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeKeyQuery(next);
            }}
          />
        </label>
        <label className="block text-sm">
          Sort keys
          <select
            className="mt-1 w-full border border-ink px-2 py-1"
            value={query.sort}
            onChange={(event) => {
              const next = {
                filter: query.filter,
                sort: keySortFrom(event.target.value),
              };
              setQuery(next);
              writeKeyQuery(next);
            }}
          >
            <option value="id">Id</option>
            <option value="name">Name</option>
          </select>
        </label>
        <p>Default order is Id.</p>
        <p>Only loaded rows</p>
      </div>
      {view.empty ? (
        <p>{canManage ? "There are no keys. Create the first key." : "There are no keys."}</p>
      ) : null}
      {list.data && shown.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Key
                </th>
                <th className="py-2 font-medium" scope="col">
                  Name
                </th>
                {canManage ? (
                  <th className="py-2 font-medium" scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((accessKey, index) => (
                <tr key={`${accessKey.id}-${index}`}>
                  <td className="break-all py-2 pr-3 align-top">{accessKey.id}</td>
                  <td className="py-2 align-top">{accessKey.name}</td>
                  {canManage ? (
                    <td className="break-all py-2 align-top">
                      <button
                        className="mr-2 border border-ink px-2 py-1 text-left"
                        type="button"
                        disabled={viewSecret.isPending && viewSecret.variables === accessKey.id}
                        onClick={() => {
                          viewSecret.reset();
                          viewSecret.mutate(accessKey.id);
                        }}
                      >
                        {viewSecret.isPending && viewSecret.variables === accessKey.id
                          ? "Reading secret"
                          : `View secret for ${accessKey.id}`}
                      </button>
                      <button
                        className="border border-ink px-2 py-1 text-left"
                        type="button"
                        onClick={() => {
                          removeKey.reset();
                          setDeleteId(accessKey.id);
                        }}
                      >
                        Delete {accessKey.id}
                      </button>
                      {viewSecret.variables === accessKey.id && viewError ? (
                        <p className="text-sm text-danger">{viewError}</p>
                      ) : null}
                      <RenameKey id={accessKey.id} name={accessKey.name} />
                      <CreateBucketSwitch id={accessKey.id} allowed={accessKey.createBucket} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {view.partial ? (
        <>
          <p>More keys are available.</p>
          <button
            className="border border-ink px-3 py-1 text-left"
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
        <ConfirmDialog
          action="delete-key"
          name={deleteId}
          pending={removeKey.isPending}
          consequence={`This permanently deletes key ${deleteId}. Clients that use this key lose access.${deleteError ? ` ${deleteError}` : ""}`}
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
      {reveal !== null ? (
        <SecretDialog
          reveal={reveal}
          onClose={() => {
            setReveal(null);
            viewSecret.reset();
          }}
        />
      ) : null}
    </section>
  );
}
