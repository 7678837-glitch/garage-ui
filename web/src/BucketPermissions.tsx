import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api/client";

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
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
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
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={!ready || grant.isPending}
      >
        Grant
      </button>
    </form>
  );
}

function RevokeKeyDialog({
  accessKeyId,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  accessKeyId: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
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
  }, [accessKeyId]);
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
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
      <h3 id={titleId} className="font-medium">
        Revoke {accessKeyId}
      </h3>
      <p>This revokes the current owner, read, and write permissions for {accessKeyId}.</p>
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
        {pending ? "Revoking key" : "Revoke key"}
      </button>
    </dialog>
  );
}

function PermissionPanel({ bucketId, canManage }: { bucketId: string; canManage: boolean }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<BucketKeyGrant | null>(null);
  const keys = useQuery({
    queryKey: permissionQueryKey(bucketId),
    queryFn: async () => parseKeys(await api<unknown>(bucketUrl(bucketId))),
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
  const message = keys.error instanceof Error ? keys.error.message : "Bucket permissions are unavailable";
  const revokeError = revoke.error instanceof Error ? revoke.error.message : null;
  return (
    <div className="mt-3 grid max-w-sm gap-2">
      {keys.isPending ? <p>Loading keys</p> : null}
      {keys.isError ? <p>{message}</p> : null}
      {keys.data && keys.data.length === 0 ? <p>This bucket has no keys.</p> : null}
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
                  className="border border-neutral-900 px-2 py-1 text-left"
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
        <RevokeKeyDialog
          accessKeyId={target.accessKeyId}
          pending={revoke.isPending}
          error={revokeError}
          onCancel={() => {
            setTarget(null);
            revoke.reset();
          }}
          onConfirm={() => {
            revoke.mutate(target);
          }}
        />
      ) : null}
    </div>
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
        className="ml-2 border border-neutral-900 px-2 py-1 text-left"
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
