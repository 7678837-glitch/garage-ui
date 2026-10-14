import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { InstantText } from "./i18n";
import { isGarageDown } from "./garageDown";

type AdminToken = {
  id: string | null;
  name: string;
  scope: string[];
  expiration: string;
  expired: boolean;
  fromConfig: boolean;
  created: string;
};

type TokenSort = "name" | "created";

type TokenQuery = {
  filter: string;
  sort: TokenSort;
};

function tokenSortFrom(value: string | null): TokenSort {
  return value === "created" ? "created" : "name";
}

function readTokenQuery(): TokenQuery {
  const params = new URLSearchParams(window.location.search);
  return {
    filter: params.get("tokens") ?? "",
    sort: tokenSortFrom(params.get("tokensSort")),
  };
}

function readTokenOffset(): number {
  const raw = new URLSearchParams(window.location.search).get("tokensOffset");
  if (raw === null || !/^[0-9]+$/.test(raw)) {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return 0;
  }
  return value;
}

function replaceListQuery(params: URLSearchParams) {
  const search = params.toString();
  const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function writeTokenQuery(query: TokenQuery) {
  const params = new URLSearchParams(window.location.search);
  if (query.filter.length > 0) {
    params.set("tokens", query.filter);
  } else {
    params.delete("tokens");
  }
  if (query.sort === "created") {
    params.set("tokensSort", "created");
  } else {
    params.delete("tokensSort");
  }
  replaceListQuery(params);
}

function writeTokenOffset(offset: number) {
  const params = new URLSearchParams(window.location.search);
  if (offset > 0) {
    params.set("tokensOffset", String(offset));
  } else {
    params.delete("tokensOffset");
  }
  replaceListQuery(params);
}

function tokenMatches(token: AdminToken, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  return token.name.toLowerCase().includes(filter.toLowerCase());
}

function orderedTokens(rows: AdminToken[], sort: TokenSort): AdminToken[] {
  const copy = [...rows];
  copy.sort((left, right) => {
    if (sort === "created") {
      return left.created.localeCompare(right.created) || left.name.localeCompare(right.name);
    }
    return (
      left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
      left.created.localeCompare(right.created)
    );
  });
  return copy;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scopeFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function tokenId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The id stays in state only to build PATCH and DELETE paths. It must not appear in text, labels, or the address bar. secretToken stays out of page state.
function adminTokenFrom(value: unknown): AdminToken {
  if (typeof value !== "object" || value === null) {
    throw new Error("Admin tokens are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") {
    throw new Error("Admin tokens are unavailable");
  }
  return {
    id: tokenId(row.id),
    name: row.name,
    scope: scopeFrom(row.scope),
    expiration: textField(row.expiration),
    expired: row.expired === true,
    fromConfig: row.fromConfig === true,
    created: textField(row.created),
  };
}

type TokenPage = {
  items: AdminToken[];
  hasMore: boolean;
};

async function loadAdminTokens(offset: number): Promise<TokenPage> {
  const body = await api<unknown>(`/api/admin-tokens?offset=${offset}&limit=100`);
  if (typeof body !== "object" || body === null) {
    throw new Error("Admin tokens are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Admin tokens are unavailable");
  }
  return {
    items: page.items.map(adminTokenFrom),
    hasMore: page.hasMore,
  };
}

async function loadCurrentAdminToken(): Promise<AdminToken> {
  return adminTokenFrom(await api<unknown>("/api/admin-tokens/current"));
}

function tokenLoadFailure(error: unknown): { message: string; code: string | null } | null {
  if (error == null || isGarageDown(error)) {
    return null;
  }
  if (error instanceof ApiError) {
    return {
      message: error.message.length > 0 ? error.message : "Admin tokens are unavailable",
      code: error.code,
    };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: "Admin tokens are unavailable", code: null };
}

function sourceLabel(token: AdminToken): string {
  return token.fromConfig ? "From configuration file" : "";
}

function issuedTokenId(token: AdminToken): string | null {
  if (token.fromConfig) {
    return null;
  }
  return token.id;
}

type TokenDraft = {
  name: string;
  expiration: string;
  neverExpires: boolean;
  scope: string[];
};

type CreateAdminTokenBody = {
  name: string;
  expiration?: string;
  neverExpires?: true;
  scope?: string[];
};

const SCOPE_GROUPS: readonly { readonly name: string; readonly endpoints: readonly string[] }[] = [
  {
    name: "Cluster",
    endpoints: [
      "ConnectClusterNodes",
      "GetClusterHealth",
      "GetClusterStatistics",
      "GetClusterStatus",
      "Metrics",
    ],
  },
  {
    name: "Node",
    endpoints: ["CreateMetadataSnapshot", "GetNodeInfo", "GetNodeStatistics"],
  },
  {
    name: "Layout",
    endpoints: [
      "ApplyClusterLayout",
      "ClusterLayoutSkipDeadNodes",
      "GetClusterLayout",
      "GetClusterLayoutHistory",
      "PreviewClusterLayoutChanges",
      "RevertClusterLayout",
      "UpdateClusterLayout",
    ],
  },
  {
    name: "Bucket",
    endpoints: [
      "AddBucketAlias",
      "CleanupIncompleteUploads",
      "CreateBucket",
      "DeleteBucket",
      "GetBucketInfo",
      "InspectObject",
      "ListBuckets",
      "RemoveBucketAlias",
      "UpdateBucket",
    ],
  },
  {
    name: "Key",
    endpoints: ["CreateKey", "DeleteKey", "GetKeyInfo", "ImportKey", "ListKeys", "UpdateKey"],
  },
  {
    name: "Permission",
    endpoints: ["AllowBucketKey", "DenyBucketKey"],
  },
  {
    name: "Worker",
    endpoints: [
      "GetWorkerInfo",
      "GetWorkerVariable",
      "LaunchRepairOperation",
      "ListWorkers",
      "SetWorkerVariable",
    ],
  },
  {
    name: "Block",
    endpoints: ["GetBlockInfo", "ListBlockErrors", "PurgeBlocks", "RetryBlockResync"],
  },
  {
    name: "Admin token",
    endpoints: [
      "CreateAdminToken",
      "DeleteAdminToken",
      "GetAdminTokenInfo",
      "GetCurrentAdminTokenInfo",
      "ListAdminTokens",
      "UpdateAdminToken",
    ],
  },
];

const SCOPE_ENDPOINTS: readonly string[] = SCOPE_GROUPS.flatMap((group) => group.endpoints);

const EMPTY_DRAFT: TokenDraft = {
  name: "",
  expiration: "",
  neverExpires: false,
  scope: [],
};

function selectionFrom(scope: readonly string[]): string[] {
  if (scope.includes("*")) {
    return [...SCOPE_ENDPOINTS];
  }
  const known = new Set<string>(SCOPE_ENDPOINTS);
  return scope.filter((item) => known.has(item));
}

function scopeWire(selected: readonly string[]): string[] | undefined {
  if (selected.length === 0) {
    return undefined;
  }
  const chosen = new Set(selected);
  if (SCOPE_ENDPOINTS.every((id) => chosen.has(id))) {
    return ["*"];
  }
  return [...chosen].sort();
}

function scopeIsFullAdmin(selected: readonly string[]): boolean {
  const chosen = new Set(selected);
  return chosen.has("CreateAdminToken") || SCOPE_ENDPOINTS.every((id) => chosen.has(id));
}

function scopeShown(selected: readonly string[]): string {
  return scopeWire(selected)?.join(", ") ?? "";
}

function withEndpoint(selected: readonly string[], id: string, checked: boolean): string[] {
  if (!checked) {
    return selected.filter((item) => item !== id);
  }
  return selected.includes(id) ? [...selected] : [...selected, id];
}

function withMembers(
  selected: readonly string[],
  members: readonly string[],
  checked: boolean,
): string[] {
  const memberSet = new Set(members);
  if (!checked) {
    return selected.filter((item) => !memberSet.has(item));
  }
  const next = new Set(selected);
  for (const id of members) {
    next.add(id);
  }
  return [...next];
}

function draftFrom(token: AdminToken): TokenDraft {
  return {
    name: token.name,
    expiration: token.expiration,
    neverExpires: token.expiration.trim().length === 0,
    scope: selectionFrom(token.scope),
  };
}

function createTokenBody(draft: TokenDraft): CreateAdminTokenBody {
  const body: CreateAdminTokenBody = { name: draft.name };
  if (draft.neverExpires) {
    body.neverExpires = true;
  } else if (draft.expiration.trim().length > 0) {
    body.expiration = draft.expiration.trim();
  }
  const scope = scopeWire(draft.scope);
  if (scope) {
    body.scope = scope;
  }
  return body;
}

function ScopePicker({
  selected,
  onChange,
}: {
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const chosen = new Set(selected);
  const allChecked = SCOPE_ENDPOINTS.every((id) => chosen.has(id));
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm">Scope</legend>
      <label className="text-sm">
        <input
          className="mr-2"
          type="checkbox"
          checked={allChecked}
          onChange={(event) => {
            onChange(event.target.checked ? [...SCOPE_ENDPOINTS] : []);
          }}
        />
        All
      </label>
      {SCOPE_GROUPS.map((group) => {
        const groupChecked = group.endpoints.every((id) => chosen.has(id));
        return (
          <div key={group.name} className="grid gap-1">
            <label className="text-sm">
              <input
                className="mr-2"
                type="checkbox"
                checked={groupChecked}
                onChange={(event) => {
                  onChange(withMembers(selected, group.endpoints, event.target.checked));
                }}
              />
              {group.name}
            </label>
            {group.endpoints.map((id) => (
              <label key={id} className="ml-4 text-sm">
                <input
                  className="mr-2"
                  type="checkbox"
                  checked={chosen.has(id)}
                  onChange={(event) => {
                    onChange(withEndpoint(selected, id, event.target.checked));
                  }}
                />
                {id}
              </label>
            ))}
          </div>
        );
      })}
      {scopeIsFullAdmin(selected) ? <p>This scope is equivalent to full admin access.</p> : null}
    </fieldset>
  );
}

function createdSecret(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const secret = (value as Record<string, unknown>).secretToken;
  if (typeof secret !== "string" || secret.length === 0) {
    return null;
  }
  return secret;
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

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [visible, setVisible] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    openDialog(dialog);
    copyRef.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
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
      <h3 id={titleId} className="font-medium">
        Admin token secret
      </h3>
      <p>This secret is shown once. Closing this dialog removes it from the page.</p>
      <label className="block">
        <span className="text-sm">Secret</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          readOnly
          autoComplete="off"
          type={visible ? "text" : "password"}
          value={secret}
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
          void copySecret(secret).then((result) => {
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
      <button className="border border-ink px-3 py-1 text-left" type="button" onClick={onClose}>
        I have saved it
      </button>
    </dialog>
  );
}

function CreateTokenForm() {
  const client = useQueryClient();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pending, setPending] = useState<TokenDraft | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (next: TokenDraft) => {
      const body = await api<unknown>("/api/admin-tokens", {
        method: "POST",
        headers: { "x-confirm": "yes" },
        body: JSON.stringify(createTokenBody(next)),
      });
      const secret = createdSecret(body);
      if (!secret) {
        throw new Error("Admin token secret is unavailable");
      }
      return secret;
    },
    onSuccess: async (secret) => {
      setPending(null);
      setDraft(EMPTY_DRAFT);
      // The secret stays in the dialog. The list refresh uses loadAdminTokens and does not write the create response into the query cache.
      setReveal(secret);
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <>
      <form
        className="grid max-w-sm gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim().length === 0 || create.isPending) {
            return;
          }
          create.reset();
          setPending(draft);
        }}
      >
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={draft.name}
            required
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </label>
        <label className="block text-sm">
          Expiration
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={draft.expiration}
            onChange={(event) => {
              setDraft({ ...draft, expiration: event.target.value });
            }}
          />
        </label>
        <label className="text-sm">
          <input
            className="mr-2"
            type="checkbox"
            checked={draft.neverExpires}
            onChange={(event) => {
              setDraft({ ...draft, neverExpires: event.target.checked });
            }}
          />
          Never expires
        </label>
        <ScopePicker
          selected={draft.scope}
          onChange={(scope) => {
            setDraft({ ...draft, scope });
          }}
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button
          className="border border-ink px-3 py-1 text-left"
          type="submit"
          disabled={create.isPending}
        >
          Create token
        </button>
      </form>
      {pending !== null ? (
        <ConfirmDialog
          action="create-admin-token"
          name={pending.name}
          scope={scopeShown(pending.scope)}
          pending={create.isPending}
          consequence="The secret is shown once. It cannot be viewed again."
          onCancel={() => {
            if (!create.isPending) {
              setPending(null);
            }
          }}
          onConfirm={() => {
            if (create.isPending) {
              return;
            }
            create.mutate(pending);
          }}
        />
      ) : null}
      {reveal !== null ? (
        <SecretDialog
          secret={reveal}
          onClose={() => {
            setReveal(null);
            create.reset();
          }}
        />
      ) : null}
    </>
  );
}

function EditTokenForm({
  id,
  token,
  onClose,
}: {
  id: string;
  token: AdminToken;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => draftFrom(token));
  const [pending, setPending] = useState<TokenDraft | null>(null);
  const update = useMutation({
    mutationFn: async (next: TokenDraft) => {
      await api<unknown>(`/api/admin-tokens/${id}`, {
        method: "PATCH",
        headers: { "x-confirm": "yes" },
        body: JSON.stringify(createTokenBody(next)),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
      onClose();
    },
  });
  const error = update.error instanceof Error ? update.error.message : null;
  return (
    <>
      <form
        className="grid max-w-sm gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim().length === 0 || update.isPending) {
            return;
          }
          update.reset();
          setPending(draft);
        }}
      >
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={draft.name}
            required
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </label>
        <label className="block text-sm">
          Expiration
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={draft.expiration}
            onChange={(event) => {
              setDraft({ ...draft, expiration: event.target.value });
            }}
          />
        </label>
        <label className="text-sm">
          <input
            className="mr-2"
            type="checkbox"
            checked={draft.neverExpires}
            onChange={(event) => {
              setDraft({ ...draft, neverExpires: event.target.checked });
            }}
          />
          Never expires
        </label>
        <ScopePicker
          selected={draft.scope}
          onChange={(scope) => {
            setDraft({ ...draft, scope });
          }}
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button
          className="border border-ink px-3 py-1 text-left"
          type="submit"
          disabled={update.isPending}
        >
          Update token
        </button>
      </form>
      {pending !== null ? (
        <ConfirmDialog
          action="update-admin-token"
          name={token.name}
          scope={scopeShown(pending.scope)}
          pending={update.isPending}
          consequence="This replaces the token name, expiration, and scope."
          onCancel={() => {
            if (!update.isPending) {
              setPending(null);
            }
          }}
          onConfirm={() => {
            if (update.isPending) {
              return;
            }
            update.mutate(pending);
          }}
        />
      ) : null}
    </>
  );
}

function TokenTable({ rows }: { rows: AdminToken[] }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<AdminToken | null>(null);
  const [removing, setRemoving] = useState<AdminToken | null>(null);
  const editingId = editing === null ? null : issuedTokenId(editing);
  const removingId = removing === null ? null : issuedTokenId(removing);
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api<unknown>(`/api/admin-tokens/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
      setRemoving(null);
    },
  });
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-left text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 font-medium" scope="col">
                Name
              </th>
              <th className="py-2 pr-3 font-medium" scope="col">
                Scope
              </th>
              <th className="py-2 pr-3 font-medium" scope="col">
                Expiration
              </th>
              <th className="py-2 pr-3 font-medium" scope="col">
                Expired
              </th>
              <th className="py-2 font-medium" scope="col">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((token, index) => (
              <tr key={`${token.name}-${token.created}-${index}`}>
                <td className="py-2 pr-3">{token.name}</td>
                <td className="py-2 pr-3">{token.scope.join(", ")}</td>
                <td className="py-2 pr-3">
                  <InstantText value={token.expiration} />
                </td>
                <td className="py-2 pr-3">{token.expired ? "Yes" : "No"}</td>
                <td className="py-2">
                  {sourceLabel(token)}
                  {issuedTokenId(token) !== null ? (
                    <>
                      <button
                        className="border border-ink px-3 py-1 text-left"
                        type="button"
                        onClick={() => {
                          setEditing(token);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="ml-2 border border-ink px-3 py-1 text-left"
                        type="button"
                        onClick={() => {
                          setRemoving(token);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing !== null && editingId !== null ? (
        <EditTokenForm
          key={`${editing.name}-${editing.created}`}
          id={editingId}
          token={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {removing !== null && removingId !== null ? (
        <ConfirmDialog
          action="delete-admin-token"
          name={removing.name}
          pending={remove.isPending}
          consequence="This deletes the admin token."
          onCancel={() => {
            if (!remove.isPending) {
              setRemoving(null);
            }
          }}
          onConfirm={() => {
            if (remove.isPending) {
              return;
            }
            remove.mutate(removingId);
          }}
        />
      ) : null}
    </>
  );
}

function CurrentToken({ token }: { token: AdminToken }) {
  return (
    <section aria-labelledby="admin-token-current">
      <h3 id="admin-token-current" className="font-semibold">
        This server
      </h3>
      <dl className="grid gap-1">
        <div>
          <dt>Name</dt>
          <dd>{token.name}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{token.scope.join(", ")}</dd>
        </div>
        <div>
          <dt>Expiration</dt>
          <dd>
            <InstantText value={token.expiration} />
          </dd>
        </div>
        <div>
          <dt>Expired</dt>
          <dd>{token.expired ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel(token)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function AdminTokens() {
  const [offset, setOffset] = useState(readTokenOffset);
  const list = useQuery({
    queryKey: ["admin-tokens", "list", offset],
    queryFn: () => loadAdminTokens(offset),
  });
  const current = useQuery({
    queryKey: ["admin-tokens", "current"],
    queryFn: loadCurrentAdminToken,
  });
  const [query, setQuery] = useState(readTokenQuery);
  useEffect(() => {
    const sync = () => {
      setQuery(readTokenQuery());
      setOffset(readTokenOffset());
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedTokens(
    (list.data?.items ?? []).filter((token) => tokenMatches(token, query.filter)),
    query.sort,
  );
  const listFailure = tokenLoadFailure(list.error);
  const currentFailure = tokenLoadFailure(current.error);

  return (
    <section
      className="grid gap-4"
      aria-label="Admin tokens"
      aria-busy={list.isPending || current.isPending}
    >
      <h2 className="text-lg font-semibold">Admin tokens</h2>
      <CreateTokenForm />
      <div className="grid max-w-sm gap-3">
        <label className="block text-sm">
          Filter admin tokens
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeTokenQuery(next);
            }}
          />
        </label>
        <label className="block text-sm">
          Sort
          <select
            className="mt-1 w-full border border-ink px-2 py-1"
            value={query.sort}
            onChange={(event) => {
              const next = { filter: query.filter, sort: tokenSortFrom(event.target.value) };
              setQuery(next);
              writeTokenQuery(next);
            }}
          >
            <option value="name">Name</option>
            <option value="created">Created</option>
          </select>
        </label>
        <p>Default sort is by name.</p>
        <div className="flex gap-2">
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={offset === 0}
            onClick={() => {
              const next = Math.max(0, offset - 100);
              setOffset(next);
              writeTokenOffset(next);
            }}
          >
            Previous
          </button>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={list.data?.hasMore !== true}
            onClick={() => {
              const next = offset + 100;
              setOffset(next);
              writeTokenOffset(next);
            }}
          >
            Next
          </button>
        </div>
      </div>
      {list.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading admin tokens" />
      ) : null}
      {listFailure ? (
        <>
          <p>{listFailure.message}</p>
          {listFailure.code ? <p>{listFailure.code}</p> : null}
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
      {currentFailure ? (
        <>
          <p>{currentFailure.message}</p>
          {currentFailure.code ? <p>{currentFailure.code}</p> : null}
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void current.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {list.isSuccess && shown.length === 0 ? <p>No admin tokens</p> : null}
      {list.isSuccess && shown.length > 0 ? <TokenTable rows={shown} /> : null}
      {current.data ? <CurrentToken token={current.data} /> : null}
    </section>
  );
}
