import { Button, Checkbox, Dialog, Select, Table, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { ReadableInstantText, copy, fill, translate } from "./i18n";
import { isGarageDown } from "./garageDown";

import { DataCell, SettingsSection } from "./ui";

type AdminToken = {
  id: string | null;
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

function readTokenOffset(): number {
  const raw = new URLSearchParams(window.location.search).get("tokensOffset");
  if (raw === null || !/^[0-9]+$/.test(raw)) {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return 0;
  }
  return value;
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

function writeTokenOffset(offset: number) {
  const params = new URLSearchParams(window.location.search);
  if (offset > 0) {
    params.set("tokensOffset", String(offset));
  } else {
    params.delete("tokensOffset");
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

function tokenId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The id stays in state only to build PATCH and DELETE paths. It must not appear in text, labels, or the address bar. secretToken stays out of page state.
function adminTokenFrom(value: unknown): AdminToken {
  if (typeof value !== "object" || value === null) {
    throw new Error(copy("ui.admin.tokens.are.unavailable"));
  }
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string") {
    throw new Error(copy("ui.admin.tokens.are.unavailable"));
  }
  return {
    id: tokenId(row.id),
    name: row.name,
    scope: scopeFrom(row.scope),
    expiration: textField(row.expiration),
    expired: row.expired === true,
    fromConfig: row.fromConfig === true,
    created: textField(row.created),
  };
}

type TokenPage = {
  items: AdminToken[];
  hasMore: boolean;
};

async function loadAdminTokens(offset: number): Promise<TokenPage> {
  const body = await api<unknown>(`/api/admin-tokens?offset=${offset}&limit=100`);
  if (typeof body !== "object" || body === null) {
    throw new Error(copy("ui.admin.tokens.are.unavailable"));
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error(copy("ui.admin.tokens.are.unavailable"));
  }
  return {
    items: page.items.map(adminTokenFrom),
    hasMore: page.hasMore,
  };
}

async function loadCurrentAdminToken(): Promise<AdminToken> {
  return adminTokenFrom(await api<unknown>("/api/admin-tokens/current"));
}

function tokenLoadFailure(error: unknown): { message: string; code: string | null } | null {
  if (error == null || isGarageDown(error)) {
    return null;
  }
  if (error instanceof ApiError) {
    return {
      message: error.message.length > 0 ? error.message : copy("ui.admin.tokens.are.unavailable"),
      code: error.code,
    };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: copy("ui.admin.tokens.are.unavailable"), code: null };
}

function sourceLabel(token: AdminToken): string {
  return token.fromConfig ? copy("ui.from.configuration.file") : "";
}

function issuedTokenId(token: AdminToken): string | null {
  if (token.fromConfig) {
    return null;
  }
  return token.id;
}

type TokenDraft = {
  name: string;
  expiration: string;
  neverExpires: boolean;
  scope: string[];
};

type CreateAdminTokenBody = {
  name: string;
  expiration?: string;
  neverExpires?: true;
  scope?: string[];
};

const SCOPE_GROUPS: readonly { readonly name: string; readonly endpoints: readonly string[] }[] = [
  {
    name: "Cluster",
    endpoints: [
      "ConnectClusterNodes",
      "GetClusterHealth",
      "GetClusterStatistics",
      "GetClusterStatus",
      "Metrics",
    ],
  },
  {
    name: "Node",
    endpoints: ["CreateMetadataSnapshot", "GetNodeInfo", "GetNodeStatistics"],
  },
  {
    name: "Layout",
    endpoints: [
      "ApplyClusterLayout",
      "ClusterLayoutSkipDeadNodes",
      "GetClusterLayout",
      "GetClusterLayoutHistory",
      "PreviewClusterLayoutChanges",
      "RevertClusterLayout",
      "UpdateClusterLayout",
    ],
  },
  {
    name: "Bucket",
    endpoints: [
      "AddBucketAlias",
      "CleanupIncompleteUploads",
      "CreateBucket",
      "DeleteBucket",
      "GetBucketInfo",
      "InspectObject",
      "ListBuckets",
      "RemoveBucketAlias",
      "UpdateBucket",
    ],
  },
  {
    name: "Key",
    endpoints: ["CreateKey", "DeleteKey", "GetKeyInfo", "ImportKey", "ListKeys", "UpdateKey"],
  },
  {
    name: "Permission",
    endpoints: ["AllowBucketKey", "DenyBucketKey"],
  },
  {
    name: "Worker",
    endpoints: [
      "GetWorkerInfo",
      "GetWorkerVariable",
      "LaunchRepairOperation",
      "ListWorkers",
      "SetWorkerVariable",
    ],
  },
  {
    name: "Block",
    endpoints: ["GetBlockInfo", "ListBlockErrors", "PurgeBlocks", "RetryBlockResync"],
  },
  {
    name: "Admin token",
    endpoints: [
      "CreateAdminToken",
      "DeleteAdminToken",
      "GetAdminTokenInfo",
      "GetCurrentAdminTokenInfo",
      "ListAdminTokens",
      "UpdateAdminToken",
    ],
  },
];

const SCOPE_ENDPOINTS: readonly string[] = SCOPE_GROUPS.flatMap((group) => group.endpoints);

const EMPTY_DRAFT: TokenDraft = {
  name: "",
  expiration: "",
  neverExpires: false,
  scope: [],
};

function selectionFrom(scope: readonly string[]): string[] {
  if (scope.includes("*")) {
    return [...SCOPE_ENDPOINTS];
  }
  const known = new Set<string>(SCOPE_ENDPOINTS);
  return scope.filter((item) => known.has(item));
}

function scopeWire(selected: readonly string[]): string[] | undefined {
  if (selected.length === 0) {
    return undefined;
  }
  const chosen = new Set(selected);
  if (SCOPE_ENDPOINTS.every((id) => chosen.has(id))) {
    return ["*"];
  }
  return [...chosen].sort();
}

function scopeIsFullAdmin(selected: readonly string[]): boolean {
  const chosen = new Set(selected);
  return chosen.has("CreateAdminToken") || SCOPE_ENDPOINTS.every((id) => chosen.has(id));
}

function scopeShown(selected: readonly string[]): string {
  return scopeWire(selected)?.join(", ") ?? "";
}

function withEndpoint(selected: readonly string[], id: string, checked: boolean): string[] {
  if (!checked) {
    return selected.filter((item) => item !== id);
  }
  return selected.includes(id) ? [...selected] : [...selected, id];
}

function withMembers(
  selected: readonly string[],
  members: readonly string[],
  checked: boolean,
): string[] {
  const memberSet = new Set(members);
  if (!checked) {
    return selected.filter((item) => !memberSet.has(item));
  }
  const next = new Set(selected);
  for (const id of members) {
    next.add(id);
  }
  return [...next];
}

function draftFrom(token: AdminToken): TokenDraft {
  return {
    name: token.name,
    expiration: token.expiration,
    neverExpires: token.expiration.trim().length === 0,
    scope: selectionFrom(token.scope),
  };
}

function createTokenBody(draft: TokenDraft): CreateAdminTokenBody {
  const body: CreateAdminTokenBody = { name: draft.name };
  if (draft.neverExpires) {
    body.neverExpires = true;
  } else if (draft.expiration.trim().length > 0) {
    body.expiration = draft.expiration.trim();
  }
  const scope = scopeWire(draft.scope);
  if (scope) {
    body.scope = scope;
  }
  return body;
}

function ScopePicker({
  selected,
  onChange,
  filter,
  onFilterChange,
}: {
  selected: readonly string[];
  onChange: (next: string[]) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
}) {
  const query = filter.trim().toLowerCase();
  const visibleGroups = SCOPE_GROUPS.map((group) => ({
    ...group,
    shown: group.endpoints.filter((id) => group.name.toLowerCase().includes(query) || id.toLowerCase().includes(query)),
  })).filter((group) => group.shown.length > 0);
  const chosen = new Set(selected);
  const allChecked = SCOPE_ENDPOINTS.every((id) => chosen.has(id));
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm">{copy("ui.scope")}</legend>
      <label className="ui-checkbox-field">
        <Checkbox size="2"

          checked={allChecked}
          onCheckedChange={(checked) => {
            onChange((checked === true) ? [...SCOPE_ENDPOINTS] : []);
          }}
        />
        {copy("ui.all")}</label>
      <label className="ui-field">
        {copy("ux.scope.filter")}
        <TextField.Root size="2" type="search" value={filter} onChange={(event) => onFilterChange(event.target.value)} />
      </label>
      <p className="ui-muted" aria-live="polite">{fill(copy("ux.scope.selected"), { count: String(chosen.size) })}</p>
      <div className="grid max-h-64 gap-2 overflow-y-auto overscroll-contain pr-1">
      {visibleGroups.map((group) => {
        const groupChecked = group.endpoints.every((id) => chosen.has(id));
        return (
          <div key={group.name} className="grid gap-1">
            <label className="ui-checkbox-field">
              <Checkbox size="2"

                checked={groupChecked}
                onCheckedChange={(checked) => {
                  onChange(withMembers(selected, group.endpoints, (checked === true)));
                }}
              />
              {group.name}
            </label>
            {group.shown.map((id) => (
              <label key={id} className="ui-checkbox-field ml-4">
                <Checkbox size="2"

                  checked={chosen.has(id)}
                  onCheckedChange={(checked) => {
                    onChange(withEndpoint(selected, id, (checked === true)));
                  }}
                />
                <span className="min-w-0 break-words">{id}</span>
              </label>
            ))}
          </div>
        );
      })}
      {visibleGroups.length === 0 ? <p>{copy("ux.scope.no.matches")}</p> : null}
      </div>
      {scopeIsFullAdmin(selected) ? <p>{copy("ui.this.scope.is.equivalent.to.full.admin.access")}</p> : null}
    </fieldset>
  );
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

function SecretDialog({ secret, onClose, returnFocus }: { secret: string; onClose: () => void; returnFocus: HTMLButtonElement | null }) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content maxWidth="480px" onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); }} onOpenAutoFocus={(event) => { event.preventDefault(); copyRef.current?.focus(); }}>
        <Dialog.Title>{copy("ui.admin.token.secret")}</Dialog.Title>
        <Dialog.Description>{copy("ui.this.secret.is.shown.once.closing.this.dialog")}</Dialog.Description>
        <label className="ui-field">
          <span>{copy("ui.secret")}</span>
          <TextField.Root size="2" readOnly autoComplete="off" type={visible ? "text" : "password"} value={secret} />
        </label>
        <div className="ui-actions">
          <Button size="2" variant="soft" color="gray" type="button" onClick={() => setVisible(true)}>{copy("ui.show.secret")}</Button>
          <Button size="2" variant="soft" color="gray" type="button" ref={copyRef} onClick={() => {
            void copySecret(secret).then((result) => {
              if (result === "copied") { setFeedback(copy("ui.copied")); return; }
              setVisible(true);
              setFeedback(copy("ui.select.the.secret.and.copy.it"));
            });
          }}>{copy("ui.copy.secret")}</Button>
          <Button size="2" variant="soft" color="gray" type="button" onClick={onClose}>{copy("ui.i.have.saved.it")}</Button>
        </div>
        {feedback ? <p role="status">{feedback}</p> : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function CreateTokenForm({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [scopeFilter, setScopeFilter] = useState("");
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
        throw new Error(copy("ui.admin.token.secret.is.unavailable"));
      }
      onOpenChange(false);
      setReveal(secret);
    },
    onSuccess: async () => {
      setPending(null);
      setDraft(EMPTY_DRAFT);
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
    },
  });
  const error = create.error instanceof Error ? create.error.message : null;
  return (
    <>
      <Dialog.Root open={open} onOpenChange={(next) => { if (!create.isPending && pending === null) onOpenChange(next); }}>
      <Dialog.Trigger><Button ref={triggerRef} size="2" variant="solid" color="orange" type="button">{copy("ui.create.token")}</Button></Dialog.Trigger>
      <Dialog.Content maxWidth="640px" aria-describedby={undefined} onEscapeKeyDown={(event) => { if (create.isPending || pending !== null) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title>{copy("ui.create.token")}</Dialog.Title>
      <form
        className="ui-form ui-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim().length === 0 || create.isPending) {
            return;
          }
          create.reset();
          setPending(draft);
        }}
      >
        <SettingsSection title={copy("ux.general")}>
        <label className="ui-field">
          {copy("ui.name")}<TextField.Root size="2"
            value={draft.name}
            required
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.expiration")}<TextField.Root size="2"
            value={draft.expiration}
            onChange={(event) => {
              setDraft({ ...draft, expiration: event.target.value });
            }}
          />
        </label>
        <label className="ui-checkbox-field">
          <Checkbox size="2"

            checked={draft.neverExpires}
            onCheckedChange={(checked) => {
              setDraft({ ...draft, neverExpires: (checked === true) });
            }}
          />
          {copy("ui.never.expires")}</label>
        </SettingsSection>
        <SettingsSection title={copy("tab.permissions")}>
        <ScopePicker
          filter={scopeFilter}
          onFilterChange={setScopeFilter}
          selected={draft.scope}
          onChange={(scope) => {
            setDraft({ ...draft, scope });
          }}
        />
        </SettingsSection>
        {error ? <p className="ui-alert">{error}</p> : null}
        <div className="ui-actions">
        <Button size="2" variant="solid" color="orange"
          type="submit"
          disabled={create.isPending}
        >
          {copy("ui.create.token")}</Button>
        <Button size="2" variant="soft" color="gray" type="button" disabled={create.isPending} onClick={() => { setDraft(EMPTY_DRAFT); create.reset(); onOpenChange(false); }}>{copy("ui.cancel")}</Button>
        </div>
      </form>
      </Dialog.Content></Dialog.Root>
      {pending !== null ? (
        <ConfirmDialog
          action="create-admin-token"
          name={pending.name}
          scope={scopeShown(pending.scope)}
          pending={create.isPending}
          consequence={copy("ui.the.secret.is.shown.once.it.cannot.be")}
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
          returnFocus={triggerRef.current}
          onClose={() => {
            setReveal(null);
            create.reset();
          }}
        />
      ) : null}
    </>
  );
}

function EditTokenForm({
  id,
  token,
  onClose,
  onRestoreFocus,
}: {
  id: string;
  token: AdminToken;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  const client = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => draftFrom(token));
  const [scopeFilter, setScopeFilter] = useState("");
  const [pending, setPending] = useState<TokenDraft | null>(null);
  const update = useMutation({
    mutationFn: async (next: TokenDraft) => {
      await api<unknown>(`/api/admin-tokens/${id}`, {
        method: "PATCH",
        headers: { "x-confirm": "yes" },
        body: JSON.stringify(createTokenBody(next)),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
      onClose();
    },
  });
  const error = update.error instanceof Error ? update.error.message : null;
  return (
    <>
      <Dialog.Root open onOpenChange={(next) => { if (!next && !update.isPending && pending === null) onClose(); }}>
      <Dialog.Content maxWidth="640px" aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); const name = formRef.current?.querySelector<HTMLInputElement>("input"); name?.focus(); name?.scrollIntoView({ block: "center" }); }} onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus(); }} onEscapeKeyDown={(event) => { if (update.isPending || pending !== null) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title>{token.name}</Dialog.Title>
      <form
        ref={formRef}
        className="ui-form ui-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim().length === 0 || update.isPending) {
            return;
          }
          update.reset();
          setPending(draft);
        }}
      >
        <SettingsSection title={copy("ux.general")}>
        <label className="ui-field">
          {copy("ui.name")}<TextField.Root size="2"
            value={draft.name}
            required
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.expiration")}<TextField.Root size="2"
            value={draft.expiration}
            onChange={(event) => {
              setDraft({ ...draft, expiration: event.target.value });
            }}
          />
        </label>
        <label className="ui-checkbox-field">
          <Checkbox size="2"

            checked={draft.neverExpires}
            onCheckedChange={(checked) => {
              setDraft({ ...draft, neverExpires: (checked === true) });
            }}
          />
          {copy("ui.never.expires")}</label>
        </SettingsSection>
        <SettingsSection title={copy("tab.permissions")}>
        <ScopePicker
          filter={scopeFilter}
          onFilterChange={setScopeFilter}
          selected={draft.scope}
          onChange={(scope) => {
            setDraft({ ...draft, scope });
          }}
        />
        </SettingsSection>
        {error ? <p className="ui-alert">{error}</p> : null}
        <div className="ui-actions">
        <Button size="2" variant="solid" color="orange"
          type="submit"
          disabled={update.isPending}
        >
          {copy("ui.update.token")}</Button>
        <Button size="2" variant="soft" color="gray" type="button" disabled={update.isPending} onClick={onClose}>{copy("ui.cancel")}</Button>
        </div>
      </form>
      </Dialog.Content></Dialog.Root>
      {pending !== null ? (
        <ConfirmDialog
          action="update-admin-token"
          name={token.name}
          scope={scopeShown(pending.scope)}
          pending={update.isPending}
          consequence={copy("ui.this.replaces.the.token.name.expiration.and.scope")}
          onCancel={() => {
            if (!update.isPending) {
              setPending(null);
            }
          }}
          onConfirm={() => {
            if (update.isPending) {
              return;
            }
            update.mutate(pending);
          }}
        />
      ) : null}
    </>
  );
}

function TokenTable({ rows }: { rows: AdminToken[] }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<AdminToken | null>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const closeEditor = () => {
    setEditing(null);
  };
  const [removing, setRemoving] = useState<AdminToken | null>(null);
  const editingId = editing === null ? null : issuedTokenId(editing);
  const removingId = removing === null ? null : issuedTokenId(removing);
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api<unknown>(`/api/admin-tokens/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin-tokens", "list"] });
      setRemoving(null);
    },
  });
  return (
    <>
      <div className="ui-table-container" role="region" aria-label={translate("Admin token list")} tabIndex={0}>
        <Table.Root className="ui-table-records">
          <Table.Header role="rowgroup">
            <Table.Row role="row">
              <Table.ColumnHeaderCell scope="col">
                {copy("ui.name")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell scope="col">
                {copy("ui.scope")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell scope="col">{copy("ui.expired")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell scope="col">{copy("ui.expiration")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell scope="col">
                {copy("ui.source")}</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell scope="col">{copy("ui.actions")}</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body role="rowgroup">
            {rows.map((token, index) => (
              <Table.Row role="row" key={`${token.name}-${token.created}-${index}`}>
                <DataCell label={copy("ui.name")} kind="identity"><strong>{token.name}</strong></DataCell>
                <DataCell label={copy("ui.scope")} className="ui-identifier">{token.scope.join(", ")}</DataCell>
                <DataCell label={copy("ui.expired")}>{token.expired ? copy("ui.yes.2") : copy("ui.no.2")}</DataCell>
                <DataCell label={copy("ui.expiration")}><ReadableInstantText value={token.expiration} /></DataCell>
                <DataCell label={copy("ui.source")}>{sourceLabel(token)}</DataCell>
                <DataCell label={copy("ui.actions")} kind="actions" className="ui-record-actions-wide">
                  {issuedTokenId(token) !== null ? <div className="ui-actions">
                    <>
                      <Button size="2" variant="soft" color="gray"
                        type="button"
                        onClick={(event) => {
                          editTrigger.current = event.currentTarget;
                          setEditing(token);
                        }}
                      >
                        {copy("ui.edit")}</Button>
                      <Button size="2" variant="solid" color="red"
                        type="button"
                        onClick={() => {
                          setRemoving(token);
                        }}
                      >
                        {copy("ui.delete.2")}</Button>
                    </>
                  </div> : null}
                </DataCell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>
      {editing !== null && editingId !== null ? (
        <EditTokenForm
          key={editingId}
          id={editingId}
          token={editing}
          onClose={closeEditor}
          onRestoreFocus={() => { if (editTrigger.current?.isConnected) editTrigger.current.focus(); }}
          />
      ) : null}
      {removing !== null && removingId !== null ? (
        <ConfirmDialog
          action="delete-admin-token"
          name={removing.name}
          pending={remove.isPending}
          consequence={copy("ui.this.deletes.the.admin.token")}
          onCancel={() => {
            if (!remove.isPending) {
              setRemoving(null);
            }
          }}
          onConfirm={() => {
            if (remove.isPending) {
              return;
            }
            remove.mutate(removingId);
          }}
        />
      ) : null}
    </>
  );
}

function CurrentToken({ token }: { token: AdminToken }) {
  return (
    <section className="ui-panel" aria-labelledby="admin-token-current">
      <h3 id="admin-token-current" className="font-semibold">
        {copy("ui.this.server")}</h3>
      <dl className="grid gap-1">
        <div>
          <dt>{copy("ui.name")}</dt>
          <dd>{token.name}</dd>
        </div>
        <div>
          <dt>{copy("ui.scope")}</dt>
          <dd>{token.scope.join(", ")}</dd>
        </div>
        <div>
          <dt>{copy("ui.expiration")}</dt>
          <dd>
            <ReadableInstantText value={token.expiration} />
          </dd>
        </div>
        <div>
          <dt>{copy("ui.expired")}</dt>
          <dd>{token.expired ? copy("ui.yes.2") : copy("ui.no.2")}</dd>
        </div>
        <div>
          <dt>{copy("ui.source")}</dt>
          <dd>{sourceLabel(token)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function AdminTokens() {
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(readTokenOffset);
  const list = useQuery({
    queryKey: ["admin-tokens", "list", offset],
    queryFn: () => loadAdminTokens(offset),
  });
  const current = useQuery({
    queryKey: ["admin-tokens", "current"],
    queryFn: loadCurrentAdminToken,
  });
  const [query, setQuery] = useState(readTokenQuery);
  useEffect(() => {
    const sync = () => {
      setQuery(readTokenQuery());
      setOffset(readTokenOffset());
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const shown = orderedTokens(
    (list.data?.items ?? []).filter((token) => tokenMatches(token, query.filter)),
    query.sort,
  );
  const listFailure = tokenLoadFailure(list.error);
  const currentFailure = tokenLoadFailure(current.error);

  return (
    <section
      className="ui-page"
      aria-label={copy("nav.tokens")}
      aria-busy={list.isPending || current.isPending}
    >
      <div className="ui-page-header"><h2>{copy("nav.tokens")}</h2>
        <CreateTokenForm open={creating} onOpenChange={setCreating} />
      </div>
      <div className="ui-toolbar">
        <label className="ui-field">
          {copy("ui.filter.admin.tokens")}<TextField.Root size="2"
            value={query.filter}
            onChange={(event) => {
              const next = { filter: event.target.value, sort: query.sort };
              setQuery(next);
              writeTokenQuery(next);
            }}
          />
        </label>
        <label className="ui-field">
          {copy("ui.sort")}<Select.Root size="2"
            value={query.sort}
            onValueChange={(value) => {
              const next = { filter: query.filter, sort: tokenSortFrom(value) };
              setQuery(next);
              writeTokenQuery(next);
            }}
          ><Select.Trigger aria-label={copy("ui.sort")} /><Select.Content>
            <Select.Item value="name">{copy("ui.name")}</Select.Item>
            <Select.Item value="created">{copy("ui.created")}</Select.Item>
          </Select.Content></Select.Root>
        </label>
        <p>{copy("ui.default.sort.is.by.name")}</p>
        <p className="ui-muted">{translate("Filtering and sorting apply to the current page")}</p>

      </div>
      {list.isPending ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.admin.tokens")}>{copy("ui.loading.admin.tokens")}</div>
      ) : null}
      {listFailure ? (
        <>
          <p>{listFailure.message}</p>
          {listFailure.code ? <p>{listFailure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void list.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {currentFailure ? (
        <>
          <p>{currentFailure.message}</p>
          {currentFailure.code ? <p>{currentFailure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void current.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {list.isSuccess && shown.length === 0 ? <p>{list.data.items.length === 0 && offset === 0 && !list.data.hasMore ? copy("ui.no.admin.tokens") : translate("No matches on this page.")}</p> : null}
      {list.isSuccess && shown.length > 0 ? <TokenTable rows={shown} /> : null}
        <div className="ui-actions">
          <Button size="2" variant="soft" color="gray"
            type="button"
            disabled={offset === 0}
            onClick={() => {
              const next = Math.max(0, offset - 100);
              setOffset(next);
              writeTokenOffset(next);
            }}
          >
            {copy("ui.previous")}</Button>
          <Button size="2" variant="soft" color="gray"
            type="button"
            disabled={list.data?.hasMore !== true}
            onClick={() => {
              const next = offset + 100;
              setOffset(next);
              writeTokenOffset(next);
            }}
          >
            {copy("ui.next")}</Button>
        </div>
      {current.data ? <CurrentToken token={current.data} /> : null}
    </section>
  );
}
