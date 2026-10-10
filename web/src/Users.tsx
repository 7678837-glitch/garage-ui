import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api/client";

type Role = "admin" | "viewer";

type Account = {
  id: number;
  username: string;
  role: Role;
  can_download: boolean;
  can_share: boolean;
  disabled: boolean;
};

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
  };
}

function parseAccounts(body: unknown): Account[] {
  if (!Array.isArray(body)) {
    throw new Error("Users are unavailable");
  }
  return body.map(parseAccount);
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
            className="border border-neutral-300 px-2 py-1"
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
              className="border border-neutral-300 px-2 py-1"
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={self || busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="border border-neutral-900 px-3 py-1 text-left"
              type="submit"
              disabled={self || busy || password.length === 0}
            >
              Reset password for {account.username}
            </button>
          </form>
        </td>
        <td className="py-2">
          <button
            className="border border-neutral-900 px-3 py-1 text-left"
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
            Delete {account.username}
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
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm">Password</span>
        <input
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm">Role</span>
        <select
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
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
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={create.isPending || username.length === 0 || password.length === 0}
      >
        Create user
      </button>
    </form>
  );
}

export function Users({ selfUsername }: { selfUsername: string }) {
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => parseAccounts(await api<unknown>("/api/users")),
  });

  return (
    <section className="grid gap-4" aria-label="Users">
      <h2 className="text-lg font-semibold">Users</h2>
      {users.isPending ? <p>Loading users</p> : null}
      {users.isError ? (
        <p>{users.error instanceof Error ? users.error.message : "Users are unavailable"}</p>
      ) : null}
      {users.isSuccess ? (
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
              {users.data.map((account) => (
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
