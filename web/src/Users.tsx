import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, captureAuthGeneration, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { copy, fill, translate } from "./i18n";

import { DataCell, SettingsSection } from "./ui";

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
  return copy("ui.request.failed.2");
}

function parseAccount(value: unknown): Account {
  if (typeof value !== "object" || value === null) {
    throw new Error(copy("ui.users.are.unavailable"));
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
    throw new Error(copy("ui.users.are.unavailable"));
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
    throw new Error(copy("ui.users.are.unavailable"));
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.users.are.unavailable"));
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

// api() puts only message on Error. The user list also shows the response code, so read the body here.
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
  return { message: copy("ui.users.are.unavailable"), code: null };
}

async function loadUsers(offset: number): Promise<UserPage> {
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(`/api/users?offset=${offset}&limit=100`, {
    credentials: "include",
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
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
      <tr role="row">
        <DataCell label={copy("ui.username")} kind="identity">{account.username}</DataCell>
        <DataCell label={copy("ui.role")}>{account.role === "admin" ? copy("ui.admin") : copy("ui.viewer")}</DataCell>
        <DataCell label={copy("ui.disabled")}>{account.disabled ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.download")}>{shown.can_download ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.share")}>{shown.can_share ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.actions")} kind="actions" className="ui-record-actions-wide">
          <details className="ui-disclosure">
            <summary aria-label={`${copy("ui.actions")}: ${account.username}`}>{copy("ui.actions")}</summary>
            <div className="ui-form">
                <details className="ui-disclosure">
                  <summary>{copy("ui.edit")}</summary>
                  <div className="ui-form">
                    <label className="ui-field">
                      <span>{copy("ui.role")}</span>
                      <select
                        aria-label={fill(copy("ui.role.for"), { username: account.username })}
                        className="ui-input"
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
                        <option value="admin">{copy("ui.admin")}</option>
                        <option value="viewer">{copy("ui.viewer")}</option>
                      </select>
                      {patch.isPending ? <span>{copy("ui.saving")}</span> : null}
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.download")}</span>
                      <input
                        aria-label={fill(copy("ui.download.for"), { username: account.username })}
                        type="checkbox"
                        checked={shown.can_download}
                        disabled={account.role !== "viewer" || busy}
                        onChange={(event) => {
                          patch.mutate(permissionBits(account.role, event.target.checked, account.can_share));
                        }}
                      />
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.share")}</span>
                      <input
                        aria-label={fill(copy("ui.share.for"), { username: account.username })}
                        type="checkbox"
                        checked={shown.can_share}
                        disabled={shareLocked}
                        onChange={(event) => {
                          patch.mutate({ can_share: event.target.checked });
                        }}
                      />
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.disabled")}</span>
                      <input
                        aria-label={fill(copy("ui.disabled.for"), { username: account.username })}
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
                    </label>
                  </div>
                </details>
                {self ? <button className="ui-button" type="button" disabled aria-label={fill(copy("ui.reset.password.for"), { username: account.username })}>{copy("ui.reset.password")}</button> : (
                  <details className="ui-disclosure">
                    <summary aria-label={fill(copy("ui.reset.password.for"), { username: account.username })}>{copy("ui.reset.password")}</summary>
                    <form
                      className="ui-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (self || password.length === 0) {
                          return;
                        }
                        setError(null);
                        reset.mutate(password);
                      }}
                    >
                      <label className="ui-field">
                        <span>{copy("ui.new.password")}</span>
                      <input
                        aria-label={fill(copy("ui.new.password.for"), { username: account.username })}
                        className="ui-input"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        disabled={self || busy}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      </label>
                      <button
                        className="ui-button"
                        type="submit"
                        aria-label={reset.isPending ? copy("ui.resetting.password") : fill(copy("ui.reset.password.for"), { username: account.username })}
                        disabled={self || busy || password.length === 0}
                      >
                        {reset.isPending ? copy("ui.resetting.password") : copy("ui.reset.password")}
                      </button>
                    </form>
                  </details>
                )}
                {reset.isSuccess ? <p>{copy("ui.password.reset")}</p> : null}
                <button
                  className="ui-button ui-button-danger"
                  aria-label={remove.isPending ? fill(copy("ui.deleting"), { username: account.username }) : fill(copy("ui.delete.3"), { username: account.username })}
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
                  {remove.isPending ? fill(copy("ui.deleting"), { username: account.username }) : copy("ui.delete.2")}
                </button>

            </div>
          </details>
        </DataCell>
      </tr>
      {error ? (
        <tr role="row">
          <DataCell label="" kind="identity" colSpan={6} className="pb-2">
            <p className="ui-alert" role="alert">{error}</p>
          </DataCell>
        </tr>
      ) : null}
    </>
  );
}

function CreateAccount({ onCancel }: { onCancel: () => void }) {
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
      aria-label={copy("ui.create.user")}
      className="ui-form ui-settings"
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
      <SettingsSection title={copy("ux.credentials")}>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.username")}</span>
        <input
          className="ui-input"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.password")}</span>
        <input
          className="ui-input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      </SettingsSection>
      <SettingsSection title={copy("tab.permissions")}>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.role")}</span>
        <select
          className="ui-input"
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
          <option value="viewer">{copy("ui.viewer")}</option>
          <option value="admin">{copy("ui.admin")}</option>
        </select>
      </label>
      <label className="ui-checkbox-field">
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
        {copy("ui.download")}</label>
      <label className="ui-checkbox-field">
        <input
          type="checkbox"
          checked={bits.can_share}
          disabled={role !== "viewer" || !download || create.isPending}
          onChange={(event) => setShare(event.target.checked)}
        />{" "}
        {copy("ui.share")}</label>
      </SettingsSection>
      {error ? <p className="ui-alert" role="alert">{error}</p> : null}
      {create.isSuccess ? <p>{copy("ui.user.created")}</p> : null}
      <button
        className="ui-button ui-button-primary"
        type="submit"
        disabled={create.isPending || username.length === 0 || password.length === 0}
      >
        {create.isPending ? copy("ui.creating.user") : copy("ui.create.user")}
      </button>
      <button className="ui-button" type="button" disabled={create.isPending} onClick={() => {
        setUsername(""); setPassword(""); setRole("viewer"); setDownload(false); setShare(false); setError(null); create.reset(); onCancel();
      }}>{copy("ui.cancel")}</button>
    </form>
  );
}

export function Users({ selfUsername }: { selfUsername: string }) {
  const createDisclosure = useRef<HTMLDetailsElement>(null);
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
    <section className="ui-page" aria-label={copy("nav.users")} aria-busy={view.busy}>
      <div className="ui-page-header"><h2>{copy("nav.users")}</h2></div>
      <details className="ui-disclosure" ref={createDisclosure}>
        <summary className="ui-button ui-button-primary">{copy("ui.create.user")}</summary>
        <CreateAccount onCancel={() => { if (createDisclosure.current) createDisclosure.current.open = false; }} />
      </details>
      <div className="ui-toolbar">
        <label className="ui-field">
          {copy("ui.filter.users")}<input
            className="ui-input"
            value={filter}
            onChange={(event) => {
              const next = event.target.value;
              setFilter(next);
              writeUserFilter(next);
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.sort.users")}<select
            className="ui-input"
            value={sort}
            onChange={(event) => {
              const next = userSortFrom(event.target.value);
              setSort(next);
              writeUserSort(next);
            }}
          >
            <option value="username">{copy("ui.username")}</option>
            <option value="created">{copy("ui.created")}</option>
          </select>
        </label>
        <p>{copy("ui.default.order.is.username")}</p>
        <p className="ui-muted">{translate("Filtering and sorting apply to the current page")}</p>

      </div>
      {view.busy ? <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.users")}>{copy("ui.loading.users")}</div> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.users")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void users.refetch();
            }}
          >
            {copy("ui.retry")}</button>
        </>
      ) : null}
      {users.isSuccess && loaded.length > 0 && shown.length === 0 ? <p>{translate("No matches on this page.")}</p> : null}
      {view.empty ? <p>{offset === 0 && users.data?.hasMore === false ? copy("ui.there.are.no.users.create.the.first.user") : translate("No matches on this page.")}</p> : null}
      {users.data && shown.length > 0 ? (
        <div className="ui-table-container" role="region" aria-label={translate("User list")} tabIndex={0}>
          <table className="ui-table ui-table-records" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col">
                  {copy("ui.username")}</th>
                <th scope="col">
                  {copy("ui.role")}</th>
                <th scope="col">{copy("ui.disabled")}</th>
                <th scope="col">{copy("ui.download")}</th>
                <th scope="col">{copy("ui.share")}</th>
                <th scope="col">{copy("ui.actions")}</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
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

        <div className="ui-actions">
          <button
            className="ui-button"
            type="button"
            disabled={offset === 0}
            onClick={() => {
              const next = Math.max(0, offset - 100);
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            {copy("ui.previous")}</button>
          <button
            className="ui-button"
            type="button"
            disabled={users.data?.hasMore !== true}
            onClick={() => {
              const next = offset + 100;
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            {copy("ui.next")}</button>
        </div>
    </section>
  );
}
