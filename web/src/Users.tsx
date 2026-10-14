import { Button, Checkbox, Dialog, Select, Table, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  const [open, setOpen] = useState(false);
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
      <Table.Row role="row">
        <DataCell label={copy("ui.username")} kind="identity"><strong>{account.username}</strong><span className="ui-user-mobile-summary" aria-hidden="true"><span>{account.role === "admin" ? copy("ui.admin") : copy("ui.viewer")}</span>{account.disabled ? <span className="text-danger">{copy("ui.disabled")}</span> : null}</span></DataCell>
        <DataCell label={copy("ui.role")} className="ui-user-role">{account.role === "admin" ? copy("ui.admin") : copy("ui.viewer")}</DataCell>
        <DataCell label={copy("ui.disabled")} className="ui-user-disabled">{account.disabled ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.download")}>{shown.can_download ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.share")}>{shown.can_share ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
        <DataCell label={copy("ui.actions")} kind="actions" className="ui-record-actions-wide">
          <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); } }}>
            <Dialog.Trigger><Button size="2" variant="soft" color="gray" type="button" aria-label={`${copy("ui.actions")}: ${account.username}`}>{copy("ui.edit")}</Button></Dialog.Trigger>
            <Dialog.Content maxWidth="480px" aria-describedby={undefined} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
            <Dialog.Title>{account.username}</Dialog.Title>
            <div className="ui-form">
                <div>
                  <div className="ui-form">
                    <label className="ui-field">
                      <span>{copy("ui.role")}</span>
                      <Select.Root size="2"
                        value={account.role}
                        disabled={self || busy}
                        onValueChange={(value) => {
                          if (self || busy) {
                            return;
                          }
                          const role = asRole(value);
                          patch.mutate({
                            role,
                            ...permissionBits(role, account.can_download, account.can_share),
                          });
                        }}
                      ><Select.Trigger aria-label={fill(copy("ui.role.for"), { username: account.username })} /><Select.Content>
                        <Select.Item value="admin">{copy("ui.admin")}</Select.Item>
                        <Select.Item value="viewer">{copy("ui.viewer")}</Select.Item>
                      </Select.Content></Select.Root>
                      {patch.isPending ? <span>{copy("ui.saving")}</span> : null}
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.download")}</span>
                      <Checkbox size="2"
                        aria-label={fill(copy("ui.download.for"), { username: account.username })}

                        checked={shown.can_download}
                        disabled={account.role !== "viewer" || busy}
                        onCheckedChange={(checked) => {
                          patch.mutate(permissionBits(account.role, (checked === true), account.can_share));
                        }}
                      />
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.share")}</span>
                      <Checkbox size="2"
                        aria-label={fill(copy("ui.share.for"), { username: account.username })}

                        checked={shown.can_share}
                        disabled={shareLocked}
                        onCheckedChange={(checked) => {
                          patch.mutate({ can_share: (checked === true) });
                        }}
                      />
                    </label>
                    <label className="ui-checkbox-field">
                      <span>{copy("ui.disabled")}</span>
                      <Checkbox size="2"
                        aria-label={fill(copy("ui.disabled.for"), { username: account.username })}

                        checked={account.disabled}
                        disabled={self || busy}
                        onCheckedChange={(checked) => {
                          if (self || busy) {
                            return;
                          }
                          patch.mutate({ disabled: (checked === true) });
                        }}
                      />
                    </label>
                  </div>
                </div>
                {self ? <Button size="2" variant="soft" color="gray" type="button" disabled aria-label={fill(copy("ui.reset.password.for"), { username: account.username })}>{copy("ui.reset.password")}</Button> : (
                  <div>
                    <form
                      className="ui-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (self || busy || password.length === 0) {
                          return;
                        }
                        setError(null);
                        reset.mutate(password);
                      }}
                    >
                      <label className="ui-field">
                        <span>{copy("ui.new.password")}</span>
                      <TextField.Root size="2"
                        aria-label={fill(copy("ui.new.password.for"), { username: account.username })}
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        disabled={self || busy}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      </label>
                      <Button size="2" variant="soft" color="gray"
                        type="submit"
                        aria-label={reset.isPending ? copy("ui.resetting.password") : fill(copy("ui.reset.password.for"), { username: account.username })}
                        disabled={self || busy || password.length === 0}
                      >
                        {reset.isPending ? copy("ui.resetting.password") : copy("ui.reset.password")}
                      </Button>
                    </form>
                  </div>
                )}
                {reset.isSuccess ? <p>{copy("ui.password.reset")}</p> : null}
                <Button size="2" variant="solid" color="red"
                  aria-label={remove.isPending ? fill(copy("ui.deleting"), { username: account.username }) : fill(copy("ui.delete.3"), { username: account.username })}
                  type="button"
                  disabled={self || busy}
                  onClick={() => {
                    if (self || busy) {
                      return;
                    }
                    setError(null);
                    remove.mutate();
                  }}
                >
                  {remove.isPending ? fill(copy("ui.deleting"), { username: account.username }) : copy("ui.delete.2")}
                </Button>

            </div>
            {error ? <p className="ui-alert" role="alert">{error}</p> : null}
            <Button size="2" variant="soft" color="gray" type="button" disabled={busy} onClick={() => setOpen(false)}>{translate("Close")}</Button>
            </Dialog.Content>
          </Dialog.Root>
        </DataCell>
      </Table.Row>
      {error && !open ? (
        <Table.Row role="row">
          <DataCell label="" kind="identity" colSpan={6} className="pb-2">
            <p className="ui-alert" role="alert">{error}</p>
          </DataCell>
        </Table.Row>
      ) : null}
    </>
  );
}

function CreateAccount({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
    <Dialog.Root open={open} onOpenChange={(next) => { if (!create.isPending) onOpenChange(next); }}>
      <Dialog.Trigger><Button size="2" variant="solid" color="orange" type="button">{copy("ui.create.user")}</Button></Dialog.Trigger>
      <Dialog.Content maxWidth="480px" aria-describedby={undefined} onEscapeKeyDown={(event) => { if (create.isPending) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title>{copy("ui.create.user")}</Dialog.Title>
    <form
      aria-label={copy("ui.create.user")}
      className="ui-form ui-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (create.isPending) return;
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
        <TextField.Root size="2"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.password")}</span>
        <TextField.Root size="2"
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
        <Select.Root size="2"
          value={role}
          onValueChange={(value) => {
            const next = asRole(value);
            setRole(next);
            if (next === "admin") {
              setDownload(false);
              setShare(false);
            }
          }}
        ><Select.Trigger aria-label={copy("ui.role")} /><Select.Content>
          <Select.Item value="viewer">{copy("ui.viewer")}</Select.Item>
          <Select.Item value="admin">{copy("ui.admin")}</Select.Item>
        </Select.Content></Select.Root>
      </label>
      <label className="ui-checkbox-field">
        <Checkbox size="2"

          checked={download}
          disabled={role !== "viewer" || create.isPending}
          onCheckedChange={(checked) => {
            const next = (checked === true);
            setDownload(next);
            if (!next) {
              setShare(false);
            }
          }}
        />{" "}
        {copy("ui.download")}</label>
      <label className="ui-checkbox-field">
        <Checkbox size="2"

          checked={bits.can_share}
          disabled={role !== "viewer" || !download || create.isPending}
          onCheckedChange={(checked) => setShare((checked === true))}
        />{" "}
        {copy("ui.share")}</label>
      </SettingsSection>
      {error ? <p className="ui-alert" role="alert">{error}</p> : null}
      {create.isSuccess ? <p>{copy("ui.user.created")}</p> : null}
      <div className="ui-actions">
      <Button size="2" variant="solid" color="orange"
        type="submit"
        disabled={create.isPending || username.length === 0 || password.length === 0}
      >
        {create.isPending ? copy("ui.creating.user") : copy("ui.create.user")}
      </Button>
      <Button size="2" variant="soft" color="gray" type="button" disabled={create.isPending} onClick={() => {
        setUsername(""); setPassword(""); setRole("viewer"); setDownload(false); setShare(false); setError(null); create.reset(); onOpenChange(false);
      }}>{copy("ui.cancel")}</Button>
      </div>
    </form>
    </Dialog.Content></Dialog.Root>
  );
}

export function Users({ selfUsername }: { selfUsername: string }) {
  const [creating, setCreating] = useState(false);
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
      <div className="ui-page-header ui-users-header"><h2>{copy("nav.users")}</h2>
      <CreateAccount open={creating} onOpenChange={setCreating} /></div>
      <div className="ui-toolbar ui-resource-filters">
        <label className="ui-field">
          {copy("ui.filter.users")}<TextField.Root size="2"
            value={filter}
            onChange={(event) => {
              const next = event.target.value;
              setFilter(next);
              writeUserFilter(next);
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.sort.users")}<Select.Root size="2"
            value={sort}
            onValueChange={(value) => {
              const next = userSortFrom(value);
              setSort(next);
              writeUserSort(next);
            }}
          ><Select.Trigger aria-label={copy("ui.sort.users")} /><Select.Content>
            <Select.Item value="username">{copy("ui.username")}</Select.Item>
            <Select.Item value="created">{copy("ui.created")}</Select.Item>
          </Select.Content></Select.Root>
        </label>
        <details className="ui-filter-help"><summary>{translate("Filtering and sorting apply to the current page")}</summary><p className="ui-muted">{copy("ui.default.order.is.username")}</p></details>

      </div>
      {view.busy ? <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.users")}>{copy("ui.loading.users")}</div> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.users")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void users.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {users.isSuccess && loaded.length > 0 && shown.length === 0 ? <p>{translate("No matches on this page.")}</p> : null}
      {view.empty ? <p>{offset === 0 && users.data?.hasMore === false ? copy("ui.there.are.no.users.create.the.first.user") : translate("No matches on this page.")}</p> : null}
      {users.data && shown.length > 0 ? (
        <div className="ui-table-container" role="region" aria-label={translate("User list")} tabIndex={0}>
          <Table.Root className="ui-table-records ui-user-list">
            <Table.Header role="rowgroup">
              <Table.Row role="row">
                <Table.ColumnHeaderCell scope="col">
                  {copy("ui.username")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell scope="col">
                  {copy("ui.role")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell scope="col">{copy("ui.disabled")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell scope="col">{copy("ui.download")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell scope="col">{copy("ui.share")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell scope="col">{copy("ui.actions")}</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body role="rowgroup">
              {shown.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  self={account.username === selfUsername}
                />
              ))}
            </Table.Body>
          </Table.Root>
        </div>
      ) : null}

        <div className="ui-actions">
          <Button size="2" variant="soft" color="gray"
            type="button"
            disabled={offset === 0}
            onClick={() => {
              const next = Math.max(0, offset - 100);
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            {copy("ui.previous")}</Button>
          <Button size="2" variant="soft" color="gray"
            type="button"
            disabled={users.data?.hasMore !== true}
            onClick={() => {
              const next = offset + 100;
              setOffset(next);
              writeUserOffset(next);
            }}
          >
            {copy("ui.next")}</Button>
        </div>
    </section>
  );
}
