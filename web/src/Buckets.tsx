import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api/client";

type Alias =
  | { scope: "global"; name: string }
  | { scope: "local"; name: string; accessKeyId: string | null };

type AliasBody = { globalAlias: string } | { localAlias: string; accessKeyId: string };

type Bucket = {
  id: string;
  aliases: Alias[];
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
  };
}

function parsePage(body: unknown): BucketPage {
  if (typeof body !== "object" || body === null) {
    throw new Error("Buckets are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Buckets are unavailable");
  }
  return {
    items: page.items.map(parseBucket),
    hasMore: page.hasMore,
  };
}

function nextOffset(offset: number, page: BucketPage): number | undefined {
  if (!page.hasMore || page.items.length === 0) {
    return undefined;
  }
  return offset + page.items.length;
}

function bucketUrl(id: string): string {
  return `/api/buckets/${encodeURIComponent(id)}`;
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

async function loadPage(offset: number): Promise<BucketPage> {
  const body = await api<unknown>(`/api/buckets?offset=${offset}&limit=${PAGE_LIMIT}`);
  return parsePage(body);
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
  const message = list.error instanceof Error ? list.error.message : "Buckets are unavailable";
  const deleteError = removeBucket.error instanceof Error ? removeBucket.error.message : null;

  return (
    <section className="grid gap-4" aria-label="Buckets">
      <h2 className="text-lg font-semibold">Buckets</h2>
      {canManage ? <CreateBucketForm /> : null}
      {list.isPending ? <p>Loading buckets</p> : null}
      {list.isError ? <p>{message}</p> : null}
      {notice ? <p>{notice}</p> : null}
      {list.data && rows.length === 0 ? <p>There are no buckets.</p> : null}
      {list.data && rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Bucket
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
      {list.hasNextPage ? (
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
