import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { ConfirmDialog } from "./confirm";
import { copy, fill } from "./i18n";

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

function yesNo(flag: boolean): string {
  return flag ? copy("ui.yes") : copy("ui.no");
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

// api() puts only message on Error. Bucket permissions also show the response code, so read the bucket here.
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
  return { message: copy("ui.bucket.permissions.are.unavailable"), code: null };
}

async function loadBucketKeys(bucketId: string): Promise<BucketKeyGrant[]> {
  const response = await fetch(bucketUrl(bucketId), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    throw new PermissionListError(failure);
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
    throw new Error(copy("ui.bucket.permissions.are.unavailable"));
  }
  const keys = (payload as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) {
    throw new Error(copy("ui.bucket.permissions.are.unavailable"));
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
      aria-label={fill(copy("ui.grant.permissions.on"), { bucketId: bucketId })}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!grantReady(draft) || grant.isPending) {
          return;
        }
        grant.mutate(draft);
      }}
    >
      <label className="block text-sm">
        {copy("ui.access.key")}<input
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
        {copy("ui.owner.2")}</label>
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
        {copy("ui.read.2")}</label>
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
        {copy("ui.write.2")}</label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {grant.isSuccess ? <p>{copy("ui.permissions.granted")}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={!ready || grant.isPending}
      >
        {grant.isPending ? copy("ui.granting") : copy("ui.grant")}
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
      aria-label={fill(copy("ui.permissions.for"), { bucketId: bucketId })}
      aria-busy={view.busy}
    >
      {view.busy ? <div className="h-16 border border-line" aria-label={copy("ui.loading.keys")} /> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.keys")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
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
            {copy("ui.retry")}</button>
        </>
      ) : null}
      {view.empty ? (
        <p>
          {canManage
            ? copy("ui.this.bucket.has.no.keys.grant.the.first")
            : copy("ui.this.bucket.has.no.keys")}
        </p>
      ) : null}
      {keys.data && keys.data.length > 0 ? (
        <ul className="grid gap-2">
          {keys.data.map((key, index) => (
            <li key={`${key.accessKeyId}-${index}`}>
              <p>{key.accessKeyId}</p>
              {key.name !== null && key.name.length > 0 ? <p>{key.name}</p> : null}
              <p>{fill(copy("ui.owner"), { flag: yesNo(key.owner) })}</p>
              <p>{fill(copy("ui.read"), { flag: yesNo(key.read) })}</p>
              <p>{fill(copy("ui.write"), { flag: yesNo(key.write) })}</p>
              {canManage && hasPermission(key) ? (
                <button
                  className="border border-ink px-2 py-1 text-left"
                  type="button"
                  onClick={() => {
                    revoke.reset();
                    setTarget(key);
                  }}
                >
                  {fill(copy("ui.revoke"), { accessKeyId: key.accessKeyId })}</button>
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
          pending={revoke.isPending}
          consequence={fill(copy("ui.this.revokes.the.current.owner.read.and.write"), { accessKeyId: target.accessKeyId, error: revokeError ? ` ${revokeError}` : "" })}
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
  expanded = false,
}: {
  bucketId: string;
  canManage: boolean;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  if (expanded) {
    return <PermissionPanel bucketId={bucketId} canManage={canManage} />;
  }
  return (
    <>
      <button
        className="ml-2 border border-ink px-2 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {fill(copy("ui.permissions.for"), { bucketId: bucketId })}</button>
      {open ? <PermissionPanel bucketId={bucketId} canManage={canManage} /> : null}
    </>
  );
}
