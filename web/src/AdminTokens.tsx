import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";

type AdminToken = {
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

// 上游响应可能带 id 或 secretToken。页面状态只留要显示的字段。
function adminTokenFrom(value: unknown): AdminToken {
  if (typeof value !== "object" || value === null) {
    throw new Error("Admin tokens are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") {
    throw new Error("Admin tokens are unavailable");
  }
  return {
    name: row.name,
    scope: scopeFrom(row.scope),
    expiration: textField(row.expiration),
    expired: row.expired === true,
    fromConfig: row.fromConfig === true,
    created: textField(row.created),
  };
}

async function loadAdminTokens(): Promise<AdminToken[]> {
  const body = await api<unknown>("/api/admin-tokens");
  if (!Array.isArray(body)) {
    throw new Error("Admin tokens are unavailable");
  }
  return body.map(adminTokenFrom);
}

async function loadCurrentAdminToken(): Promise<AdminToken> {
  return adminTokenFrom(await api<unknown>("/api/admin-tokens/current"));
}

function errorMessage(error: unknown): string | null {
  if (error == null || isGarageDown(error)) {
    return null;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Admin tokens are unavailable";
}

function sourceLabel(token: AdminToken): string {
  return token.fromConfig ? "From configuration file" : "";
}

type TokenDraft = {
  name: string;
  expiration: string;
  neverExpires: boolean;
  scope: string;
};

type CreateAdminTokenBody = {
  name: string;
  expiration?: string;
  neverExpires?: true;
  scope?: string[];
};

const EMPTY_DRAFT: TokenDraft = {
  name: "",
  expiration: "",
  neverExpires: false,
  scope: "",
};

function scopeItems(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function scopeIsFullAdmin(items: string[]): boolean {
  return items.includes("*") || items.includes("CreateAdminToken");
}

function createTokenBody(draft: TokenDraft): CreateAdminTokenBody {
  const body: CreateAdminTokenBody = { name: draft.name };
  if (draft.neverExpires) {
    body.neverExpires = true;
  } else if (draft.expiration.trim().length > 0) {
    body.expiration = draft.expiration.trim();
  }
  const scope = scopeItems(draft.scope);
  if (scope.length > 0) {
    body.scope = scope;
  }
  return body;
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
      // secret 只留在对话框。列表刷新走 loadAdminTokens，不把创建响应写进查询缓存。
      setReveal(secret);
      await client.invalidateQueries({ queryKey: ["admin-tokens"], exact: true });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  const items = scopeItems(draft.scope);
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
        <label className="block text-sm">
          Scope
          <input
            className="mt-1 w-full border border-ink px-2 py-1"
            value={draft.scope}
            onChange={(event) => {
              setDraft({ ...draft, scope: event.target.value });
            }}
          />
        </label>
        {scopeIsFullAdmin(items) ? <p>This scope is equivalent to full admin access.</p> : null}
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
          scope={pending.scope}
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

function TokenTable({ rows }: { rows: AdminToken[] }) {
  return (
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
              <td className="py-2 pr-3">{token.expiration}</td>
              <td className="py-2 pr-3">{token.expired ? "Yes" : "No"}</td>
              <td className="py-2">{sourceLabel(token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
          <dd>{token.expiration}</dd>
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
  const list = useQuery({
    queryKey: ["admin-tokens"],
    queryFn: loadAdminTokens,
  });
  const current = useQuery({
    queryKey: ["admin-tokens", "current"],
    queryFn: loadCurrentAdminToken,
  });
  const [query, setQuery] = useState(readTokenQuery);
  useEffect(() => {
    const sync = () => setQuery(readTokenQuery());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedTokens(
    (list.data ?? []).filter((token) => tokenMatches(token, query.filter)),
    query.sort,
  );
  const failures = [
    ...new Set(
      [errorMessage(list.error), errorMessage(current.error)].filter(
        (message): message is string => message !== null,
      ),
    ),
  ];

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
      </div>
      {list.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading admin tokens" />
      ) : null}
      {failures.map((message) => (
        <p key={message}>{message}</p>
      ))}
      {list.isSuccess && shown.length === 0 ? <p>No admin tokens</p> : null}
      {list.isSuccess && shown.length > 0 ? <TokenTable rows={shown} /> : null}
      {current.data ? <CurrentToken token={current.data} /> : null}
    </section>
  );
}
