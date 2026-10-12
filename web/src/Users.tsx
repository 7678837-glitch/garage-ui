import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";

type Role = "admin" | "viewer";

type Account = {
  id: number;
  username: string;
  role: Role;
  can_download: boolean;
  can_share: boolean;
  disabled: boolean;
  createdAt: number | null;
};

type UserSort = "username" | "created";

type PermissionBits = {
  can_download: boolean;
  can_share: boolean;
};

type AccountPatch = {
  role?: Role;
  can_download?: boolean;
  can_share?: boolean;
  disabled?: boolean;
};

type CreateBody = {
  username: string;
  password: string;
  role: Role;
  can_download: boolean;
  can_share: boolean;
};

function permissionBits(role: Role, download: boolean, share: boolean): PermissionBits {
  if (role === "admin") {
    return { can_download: false, can_share: false };
  }
  return { can_download: download, can_share: download && share };
}

function asRole(value: string): Role {
  return value === "admin" ? "admin" : "viewer";
}

function readUserFilter(): string {
  return new URLSearchParams(window.location.search).get("users") ?? "";
}

function userSortFrom(value: string | null): UserSort {
  return value === "created" ? "created" : "username";
}

function readUserSort(): UserSort {
  return userSortFrom(new URLSearchParams(window.location.search).get("usersSort"));
}

function readUserOffset(): number {
  const raw = new URLSearchParams(window.location.search).get("usersOffset");
  if (raw === null || !/^[0-9]+$/.test(raw)) {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return 0;
  }
  return value;
}

function replaceAddress(params: URLSearchParams) {
  const search = params.toString();
  const next = `${window.location.pathname}${search.length > 0 ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function writeUserFilter(filter: string) {
  const params = new URLSearchParams(window.location.search);
  if (filter.length > 0) {
    params.set("users", filter);
  } else {
    params.delete("users");
  }
  replaceAddress(params);
}

function writeUserSort(sort: UserSort) {
  const params = new URLSearchParams(window.location.search);
  if (sort === "created") {
    params.set("usersSort", "created");
  } else {
    params.delete("usersSort");
  }
  replaceAddress(params);
}

function writeUserOffset(offset: number) {
  const params = new URLSearchParams(window.location.search);
  if (offset > 0) {
    params.set("usersOffset", String(offset));
  } else {
    params.delete("usersOffset");
  }
  replaceAddress(params);
}

function userMatches(account: Account, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  return account.username.toLowerCase().includes(filter.toLowerCase());
}

function compareCreated(left: number | null, right: number | null): number {
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

function orderedAccounts(rows: Account[], sort: UserSort): Account[] {
  const copy = [...rows];
  switch (sort) {
    case "username":
      copy.sort((left, right) =>
        left.username.toLowerCase().localeCompare(right.username.toLowerCase()),
      );
      return copy;
    case "created":
      copy.sort((left, right) => compareCreated(left.createdAt, right.createdAt));
      return copy;
  }
}

function createdAtFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

function errorText(caught: unknown): string {
  if (caught instanceof Error && caught.message.length > 0) {
    return caught.message;
  }
  return "Request failed";
}

function parseAccount(value: unknown): Account {
  if (typeof value !== "object" || value === null) {
    throw new Error("Users are unavailable");
  }
  const row = value as Record<string, unknown>;
  const role = row.role;
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    typeof row.username !== "string" ||
    (role !== "admin" && role !== "viewer") ||
    typeof row.can_download !== "boolean" ||
    typeof row.can_share !== "boolean" ||
    typeof row.disabled !== "boolean"
  ) {
    throw new Error("Users are unavailable");
  }
  return {
    id: row.id,
    username: row.username,
    role,
    can_download: row.can_download,
    can_share: row.can_share,
    disabled: row.disabled,
    createdAt: createdAtFrom(row.created_at),
  };
}

type UserPage = {
  items: Account[];
  hasMore: boolean;
};

function parseUserPage(body: unknown): UserPage {
  if (typeof body !== "object" || body === null) {
    throw new Error("Users are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Users are unavailable");
  }
  return {
    items: page.items.map(parseAccount),
    hasMore: page.hasMore,
  };
}

type UserListFailure = {
  message: string;
  code: string | null;
};

class UserListError extends Error {
  readonly code: string | null;

  constructor(failure: UserListFailure) {
    super(failure.message);
    this.name = "UserListError";
    this.code = failure.code;
  }
}

// api() 只把 message 放进 Error。用户列表还要显示 body 里的 code，所以这里自己读响应。
function failureFrom(text: string, status: number): UserListFailure {
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

function userListFailure(error: unknown): UserListFailure {
  if (error instanceof UserListError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null };
  }
  return { message: "Users are unavailable", code: null };
}

async function loadUsers(offset: number): Promise<UserPage> {
  const response = await fetch(`/api/users?offset=${offset}&limit=100`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    throw new UserListError(failure);
  }
  return parseUserPage(text ? (JSON.parse(text) as unknown) : undefined);
}

function AccountRow({ account, self }: { account: Account; self: boolean }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const shown = permissionBits(account.role, account.can_download, account.can_share);
  const patch = useMutation({
    mutationFn: (body: AccountPatch) =>
      api(`/api/users/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      setError(null);
      await client.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (caught) => {
      setError(errorText(caught));
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/users/${account.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setError(null);
      await client.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (caught) => {
      setError(errorText(caught));
    },
  });
  const reset = useMutation({
    mutationFn: (next: string) =>
      api(`/api/users/${account.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: next }),
      }),
    onSuccess: () => {
      setPassword("");
      setError(null);
    },
    onError: (caught) => {
      setError(errorText(caught));
    },
  });
  const busy = patch.isPending || remove.isPending || reset.isPending;
  const shareLocked = account.role !== "viewer" || !shown.can_download || busy;

  return (
    <>
      <tr>
        <td className="py-2 pr-3">{account.username}</td>
        <td className="py-2 pr-3">
          <select
            aria-label={`Role for ${account.username}`}
            className="border border-line px-2 py-1"
            value={account.role}
            disabled={self || busy}
            onChange={(event) => {
              if (self) {
                return;
              }
              const role = asRole(event.target.value);
              patch.mutate({
                role,
                ...permissionBits(role, account.can_download, account.can_share),
              });
            }}
          >
            <option value="admin">admin</option>
            <option value="viewer">viewer</option>
          </select>
          {patch.isPending ? <span>Saving</span> : null}
        </td>
        <td className="py-2 pr-3">
          <input
            aria-label={`Download for ${account.username}`}
            type="checkbox"
            checked={shown.can_download}
            disabled={account.role !== "viewer" || busy}
            onChange={(event) => {
              patch.mutate(permissionBits(account.role, event.target.checked, account.can_share));
            }}
          />
        </td>
        <td className="py-2 pr-3">
          <input
            aria-label={`Share for ${account.username}`}
            type="checkbox"
            checked={shown.can_share}
            disabled={shareLocked}
            onChange={(event) => {
              patch.mutate({ can_share: event.target.checked });
            }}
          />
        </td>
        <td className="py-2 pr-3">
          <input
            aria-label={`Disabled for ${account.username}`}
            type="checkbox"
            checked={account.disabled}
            disabled={self || busy}
            onChange={(event) => {
              if (self) {
                return;
              }
              patch.mutate({ disabled: event.target.checked });
            }}
          />
        </td>
        <td className="py-2 pr-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (self || password.length === 0) {
                return;
              }
              setError(null);
              reset.mutate(password);
            }}
          >
            <input
              aria-label={`New password for ${account.username}`}
              className="border border-line px-2 py-1"
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={self || busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="border border-ink px-3 py-1 text-left"
              type="submit"
              disabled={self || busy || password.length === 0}
            >
              {reset.isPending ? "Resetting password" : `Reset password for ${account.username}`}
            </button>
          </form>
          {reset.isSuccess ? <p>Password reset</p> : null}
        </td>
        <td className="py-2">
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            disabled={self || busy}
            onClick={() => {
              if (self) {
                return;
              }
              setError(null);
              remove.mutate();
            }}
          >
            {remove.isPending ? `Deleting ${account.username}` : `Delete ${account.username}`}
          </button>
        </td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={7} className="pb-2">
            <p role="alert">{error}</p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CreateAccount() {
  const client = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [download, setDownload] = useState(false);
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bits = permissionBits(role, download, share);
  const create = useMutation({
    mutationFn: (body: CreateBody) =>
      api("/api/users", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setUsername("");
      setPassword("");
      setRole("viewer");
      setDownload(false);
      setShare(false);
      setError(null);
      await client.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (caught) => {
      setError(errorText(caught));
    },
  });

  return (
    <form
      aria-label="Create user"
      className="grid max-w-sm gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        create.mutate({
          username,
          password,
          role,
          can_download: bits.can_download,
          can_share: bits.can_share,
        });
      }}
    >
      <label className="block">
        <span className="text-sm">Username</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm">Password</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm">Role</span>
        <select
          className="mt-1 w-full border border-line px-2 py-1"
          value={role}
          onChange={(event) => {
            const next = asRole(event.target.value);
            setRole(next);
            if (next === "admin") {
              setDownload(false);
              setShare(false);
            }
          }}
        >
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={download}
          disabled={role !== "viewer" || create.isPending}
          onChange={(event) => {
            const next = event.target.checked;
            setDownload(next);
            if (!next) {
              setShare(false);
            }
          }}
        />{" "}
        Download
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={bits.can_share}
          disabled={role !== "viewer" || !download || create.isPending}
          onChange={(event) => setShare(event.target.checked)}
        />{" "}
        Share
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {create.isSuccess ? <p>User created</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={create.isPending || username.length === 0 || password.length === 0}
      >
        {create.isPending ? "Creating user" : "Create user"}
      </button>
    </form>
  );
}

export function Users({ selfUsername }: { selfUsername: string }) {
  const [offset, setOffset] = useState(readUserOffset);
  const users = useQuery({
    queryKey: ["users", offset],
    queryFn: () => loadUsers(offset),
  });
  const loaded = users.data?.items ?? [];
  const [filter, setFilter] = useState(readUserFilter);
  const [sort, setSort] = useState(readUserSort);
  useEffect(() => {
    const sync = () => {
      setFilter(readUserFilter());
      setSort(readUserSort());
      setOffset(readUserOffset());
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedAccounts(loaded, sort).filter((account) => userMatches(account, filter));
  const view = {
    busy: users.isPending,
    refreshing: loaded.length > 0 && users.isFetching && !users.isPending,
    empty: Boolean(users.data) && loaded.length === 0,
    failure: users.isError ? userListFailure(users.error) : null,
  };

  return (
    <section className="grid gap-4" aria-label="Users" aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">Users</h2>
      <div className="grid max-w-sm gap-3">
        <label className="block text-sm">
          Filter users
          <input
            className="mt-1 w-full border border-line px-2 py-1"
            value={filter}
            onChange={(event) => {
              const next = event.target.value;
              setFilter(next);
              writeUserFilter(next);
            }}
          />
        </label>
        <label className="block text-sm">
          Sort users
          <select
            className="mt-1 w-full border border-line px-2 py-1"
            value={sort}
            onChange={(event) => {
              const next = userSortFrom(event.target.value);
              setSort(next);
              writeUserSort(next);
            }}
          >
            <option value="username">Username</option>
            <option value="created">Created</option>
          </select>
        </label>
        <p>Default order is Username.</p>
        <div className="flex gap-2">
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={offset === 0}
            onClick={() => {
              const next = Math.max(0, offset - 100);
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            Previous
          </button>
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
            type="button"
            disabled={users.data?.hasMore !== true}
            onClick={() => {
              const next = offset + 100;
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            Next
          </button>
        </div>
      </div>
      {view.busy ? <div className="h-16 border border-line" aria-label="Loading users" /> : null}
      {view.refreshing ? <p>Refreshing users</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void users.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {view.empty ? <p>There are no users. Create the first user.</p> : null}
      {users.data && shown.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Username
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Role
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Download
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Share
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Disabled
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Reset password
                </th>
                <th className="py-2 font-medium" scope="col">
                  Delete
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  self={account.username === selfUsername}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <CreateAccount />
    </section>
  );
}
