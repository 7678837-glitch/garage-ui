import { Button, Checkbox, Dialog, Table, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, captureAuthGeneration, noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { ConfirmDialog } from "./confirm";
import { copy, fill, translate } from "./i18n";
import { DataCell, ResourceIdentity } from "./ui";

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
  const requestGeneration = captureAuthGeneration();
  const response = await fetch(bucketUrl(bucketId), { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code, requestGeneration);
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

function GrantForm({ bucketId, onPendingChange }: { bucketId: string; onPendingChange: (pending: boolean) => void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(blankGrant);
  const grant = useMutation({
    mutationFn: (body: GrantDraft) =>
      api(permissionsUrl(bucketId), {
        method: "POST",
        body: permissionBody(body.accessKeyId.trim(), body.owner, body.read, body.write),
      }),
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: async () => {
      setDraft(blankGrant);
      await client.invalidateQueries({ queryKey: permissionQueryKey(bucketId) });
    },
  });
  const error = grant.error instanceof Error ? grant.error.message : null;
  const ready = grantReady(draft);
  return (
    <form
      className="ui-form"
      aria-label={fill(copy("ui.grant.permissions.on"), { bucketId: bucketId })}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!grantReady(draft) || grant.isPending) {
          return;
        }
        grant.mutate(draft);
      }}
    >
      <label className="ui-field">
        {copy("ui.access.key")}<TextField.Root size="2"
          autoComplete="off"
          value={draft.accessKeyId}
          onChange={(event) => {
            const accessKeyId = event.target.value;
            setDraft((current) => ({ ...current, accessKeyId }));
          }}
        />
      </label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={grant.isPending} checked={draft.owner} onCheckedChange={(checked) => {
            setDraft((current) => ({ ...current, owner: checked === true }));
          }} />
        {copy("ui.owner.2")}</label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={grant.isPending} checked={draft.read} onCheckedChange={(checked) => {
            setDraft((current) => ({ ...current, read: checked === true }));
          }} />
        {copy("ui.read.2")}</label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={grant.isPending} checked={draft.write} onCheckedChange={(checked) => {
            setDraft((current) => ({ ...current, write: checked === true }));
          }} />
        {copy("ui.write.2")}</label>
      {error ? <p className="ui-alert">{error}</p> : null}
      {grant.isSuccess ? <p>{copy("ui.permissions.granted")}</p> : null}
      <Button size="2" variant="solid"
        type="submit"
        disabled={!ready || grant.isPending}
      >
        {grant.isPending ? copy("ui.granting") : copy("ui.grant")}
      </Button>
    </form>
  );
}

function PermissionPanel({ bucketId, canManage }: { bucketId: string; canManage: boolean }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<BucketKeyGrant | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantPending, setGrantPending] = useState(false);
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
      className="ui-page"
      aria-label={fill(copy("ui.permissions.for"), { bucketId: bucketId })}
      aria-busy={view.busy}
    >
      {view.busy ? <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.keys")}>{copy("ui.loading.keys")}</div> : null}
      {view.refreshing ? <p>{copy("ui.refreshing.keys")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" color="gray" variant="soft"
            type="button"
            onClick={() => {
              void keys.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
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
        <div className="ui-table-container" role="region" aria-label={copy("nav.keys")} tabIndex={0}>
          <Table.Root className="ui-table ui-table-records"><Table.Header><Table.Row>
            <Table.ColumnHeaderCell>{copy("ui.key.2")}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>{copy("ui.owner.2")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{copy("ui.read.2")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{copy("ui.write.2")}</Table.ColumnHeaderCell>
            {canManage ? <Table.ColumnHeaderCell>{copy("ui.actions")}</Table.ColumnHeaderCell> : null}
          </Table.Row></Table.Header><Table.Body>{keys.data.map((key, index) => (
            <Table.Row key={`${key.accessKeyId}-${index}`} role="row">
              <DataCell kind="identity" label={copy("ui.key.2")}><ResourceIdentity id={key.accessKeyId} name={key.name || undefined} /></DataCell>
              <DataCell label={copy("ui.owner.2")}>{fill(copy("ui.owner"), { flag: yesNo(key.owner) })}</DataCell>
              <DataCell label={copy("ui.read.2")}>{fill(copy("ui.read"), { flag: yesNo(key.read) })}</DataCell>
              <DataCell label={copy("ui.write.2")}>{fill(copy("ui.write"), { flag: yesNo(key.write) })}</DataCell>
              {canManage ? <DataCell kind="actions" className="ui-record-actions-wide" label={copy("ui.actions")}>{hasPermission(key) ? <Button size="2" color="red" type="button"
                aria-label={fill(copy("ui.revoke"), { accessKeyId: key.accessKeyId })}
                onClick={() => { revoke.reset(); setTarget(key); }}>{translate("Revoke")}</Button> : null}</DataCell> : null}
            </Table.Row>
          ))}</Table.Body></Table.Root>
        </div>
      ) : null}
      {canManage ? <Dialog.Root open={grantOpen} onOpenChange={(open) => { if (!grantPending) setGrantOpen(open); }}>
        <Dialog.Trigger><Button size="2" color="gray" variant="soft">{copy("ui.grant.key")}</Button></Dialog.Trigger>
        <Dialog.Content maxWidth="480px" aria-busy={grantPending}
          onEscapeKeyDown={(event) => { if (grantPending) event.preventDefault(); }}
          onInteractOutside={(event) => { if (grantPending) event.preventDefault(); }}>
          <Dialog.Title>{copy("ui.grant.key")}</Dialog.Title>
          <Dialog.Description>{fill(copy("ui.grant.permissions.on"), { bucketId })}</Dialog.Description>
          <GrantForm bucketId={bucketId} onPendingChange={setGrantPending} />
          <div className="ui-actions"><Button size="2" color="gray" variant="soft" disabled={grantPending} onClick={() => setGrantOpen(false)}>{copy("ui.cancel")}</Button></div>
        </Dialog.Content>
      </Dialog.Root> : null}
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
      <Button size="2" color="gray" variant="soft"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {fill(copy("ui.permissions.for"), { bucketId: bucketId })}</Button>
      {open ? <PermissionPanel bucketId={bucketId} canManage={canManage} /> : null}
    </>
  );
}
