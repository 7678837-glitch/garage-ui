import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "./api/client";
import { ConfirmDialog } from "./confirm";

type BucketKeyGrant = {
  accessKeyId: string;
  name: string | null;
  owner: boolean;
  read: boolean;
  write: boolean;
};

type GrantDraft = {
  accessKeyId: string;
  owner: boolean;
  read: boolean;
  write: boolean;
};

const blankGrant: GrantDraft = {
  accessKeyId: "",
  owner: false,
  read: false,
  write: false,
};

export function bucketUrl(id: string): string {
  return `/api/buckets/${encodeURIComponent(id)}`;
}

function permissionsUrl(bucketId: string): string {
  return `${bucketUrl(bucketId)}/permissions`;
}

function permissionQueryKey(bucketId: string): readonly [string, string] {
  return ["bucket-permissions", bucketId];
}

function permissionBody(
  accessKeyId: string,
  owner: boolean,
  read: boolean,
  write: boolean,
): string {
  return JSON.stringify({
    accessKeyId,
    permissions: { owner, read, write },
  });
}

function grantReady(draft: GrantDraft): boolean {
  return draft.accessKeyId.trim().length > 0 && (draft.owner || draft.read || draft.write);
}

function hasPermission(key: BucketKeyGrant): boolean {
  return key.owner || key.read || key.write;
}

function yesNo(flag: boolean): "yes" | "no" {
  return flag ? "yes" : "no";
}

type PermissionFailure = {
  message: string;
  code: string | null;
};

class PermissionListError extends Error {
  readonly code: string | null;

  constructor(failure: PermissionFailure) {
    super(failure.message);
    this.name = "PermissionListError";
    this.code = failure.code;
  }
}

// api() 只把 message 放进 Error。桶权限还要显示响应里的 code，所以这里自己读桶详情。
function failureFrom(text: string, status: number): PermissionFailure {
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

function permissionFailure(error: unknown): PermissionFailure {
  if (error instanceof PermissionListError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null };
  }
  return { message: "Bucket permissions are unavailable", code: null };
}

async function loadBucketKeys(bucketId: string): Promise<BucketKeyGrant[]> {
  const response = await fetch(bucketUrl(bucketId), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    throw new PermissionListError(failureFrom(text, response.status));
  }
  return parseKeys(text ? (JSON.parse(text) as unknown) : undefined);
}

function flag(value: unknown): boolean {
  return value === true;
}

function parseKey(value: unknown): BucketKeyGrant | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.accessKeyId !== "string" || row.accessKeyId.length === 0) {
    return null;
  }
  const permissions = row.permissions;
  const bits =
    typeof permissions === "object" && permissions !== null
      ? (permissions as Record<string, unknown>)
      : {};
  const name = typeof row.name === "string" ? row.name : null;
  return {
    accessKeyId: row.accessKeyId,
    name,
    owner: flag(bits.owner),
    read: flag(bits.read),
    write: flag(bits.write),
  };
}

function parseKeys(payload: unknown): BucketKeyGrant[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Bucket permissions are unavailable");
  }
  const keys = (payload as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) {
    throw new Error("Bucket permissions are unavailable");
  }
  const grants: BucketKeyGrant[] = [];
  for (const entry of keys) {
    const grant = parseKey(entry);
    if (grant !== null) {
      grants.push(grant);
    }
  }
  return grants;
}

function GrantForm({ bucketId }: { bucketId: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(blankGrant);
  const grant = useMutation({
    mutationFn: (body: GrantDraft) =>
      api(permissionsUrl(bucketId), {
        method: "POST",
        body: permissionBody(body.accessKeyId.trim(), body.owner, body.read, body.write),
      }),
    onSuccess: async () => {
      setDraft(blankGrant);
      await client.invalidateQueries({ queryKey: permissionQueryKey(bucketId) });
    },
  });
  const error = grant.error instanceof Error ? grant.error.message : null;
  const ready = grantReady(draft);
  return (
    <form
      className="grid gap-2"
      aria-label={`Grant permissions on ${bucketId}`}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!grantReady(draft) || grant.isPending) {
          return;
        }
        grant.mutate(draft);
      }}
    >
      <label className="block text-sm">
        Access key
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          autoComplete="off"
          value={draft.accessKeyId}
          onChange={(event) => {
            const accessKeyId = event.target.value;
            setDraft((current) => ({ ...current, accessKeyId }));
          }}
        />
      </label>
      <label className="block text-sm">
        <input
          className="mr-2"
          type="checkbox"
          checked={draft.owner}
          onChange={(event) => {
            const owner = event.target.checked;
            setDraft((current) => ({ ...current, owner }));
          }}
        />
        Owner
      </label>
      <label className="block text-sm">
        <input
          className="mr-2"
          type="checkbox"
          checked={draft.read}
          onChange={(event) => {
            const read = event.target.checked;
            setDraft((current) => ({ ...current, read }));
          }}
        />
        Read
      </label>
      <label className="block text-sm">
        <input
          className="mr-2"
          type="checkbox"
          checked={draft.write}
          onChange={(event) => {
            const write = event.target.checked;
            setDraft((current) => ({ ...current, write }));
          }}
        />
        Write
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={!ready || grant.isPending}
      >
        Grant
      </button>
    </form>
  );
}

function PermissionPanel({ bucketId, canManage }: { bucketId: string; canManage: boolean }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<BucketKeyGrant | null>(null);
  const keys = useQuery({
    queryKey: permissionQueryKey(bucketId),
    queryFn: () => loadBucketKeys(bucketId),
  });
  const revoke = useMutation({
    mutationFn: (key: BucketKeyGrant) =>
      api(permissionsUrl(bucketId), {
        method: "DELETE",
        body: permissionBody(key.accessKeyId, key.owner, key.read, key.write),
      }),
    onSuccess: async () => {
      setTarget(null);
      await client.invalidateQueries({ queryKey: permissionQueryKey(bucketId) });
    },
  });
  const rows = keys.data ?? [];
  const view = {
    busy: keys.isPending,
    refreshing: rows.length > 0 && keys.isFetching && !keys.isPending,
    empty: keys.data !== undefined && rows.length === 0,
    failure: keys.isError ? permissionFailure(keys.error) : null,
  };
  const revokeError = revoke.error instanceof Error ? revoke.error.message : null;
  return (
    <section
      className="mt-3 grid max-w-sm gap-2"
      aria-label={`Permissions for ${bucketId}`}
      aria-busy={view.busy}
    >
      {view.busy ? <p>Loading keys</p> : null}
      {view.refreshing ? <p>Refreshing keys</p> : null}
      {view.failure ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void keys.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {view.empty ? <p>This bucket has no keys.</p> : null}
      {keys.data && keys.data.length > 0 ? (
        <ul className="grid gap-2">
          {keys.data.map((key, index) => (
            <li key={`${key.accessKeyId}-${index}`}>
              <p>{key.accessKeyId}</p>
              {key.name !== null && key.name.length > 0 ? <p>{key.name}</p> : null}
              <p>owner {yesNo(key.owner)}</p>
              <p>read {yesNo(key.read)}</p>
              <p>write {yesNo(key.write)}</p>
              {canManage && hasPermission(key) ? (
                <button
                  className="border border-ink px-2 py-1 text-left"
                  type="button"
                  onClick={() => {
                    revoke.reset();
                    setTarget(key);
                  }}
                >
                  Revoke {key.accessKeyId}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? <GrantForm bucketId={bucketId} /> : null}
      {target !== null ? (
        <ConfirmDialog
          action="revoke-permission"
          name={target.accessKeyId}
          consequence={`This revokes the current owner, read, and write permissions for ${target.accessKeyId}.${revokeError ? ` ${revokeError}` : ""}`}
          onCancel={() => {
            setTarget(null);
            revoke.reset();
          }}
          onConfirm={() => {
            if (revoke.isPending) {
              return;
            }
            revoke.mutate(target);
          }}
        />
      ) : null}
    </section>
  );
}

export function BucketPermissions({
  bucketId,
  canManage,
}: {
  bucketId: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="ml-2 border border-ink px-2 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Permissions for {bucketId}
      </button>
      {open ? <PermissionPanel bucketId={bucketId} canManage={canManage} /> : null}
    </>
  );
}
