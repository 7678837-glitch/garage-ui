import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api/client";
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

function TokenTable({ rows }: { rows: AdminToken[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
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
