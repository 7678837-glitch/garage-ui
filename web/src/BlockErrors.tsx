import { Button, Table } from "@radix-ui/themes";
import { OperationNodeSelection } from "./ClusterNodes";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";
import { blockErrorsNodeId, useLocationHash } from "./Nav";
import { DataCell, ResourceIdentity } from "./ui";
import { copy, fill, translate } from "./i18n";

function unavailableMessage(): string {
  return copy("ui.block.errors.are.unavailable");
}

function failureOf(error: unknown): { message: string; code: string | null } {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, code: null };
  }
  return { message: unavailableMessage(), code: null };
}

type BlockError = {
  blockHash: string;
  refcount: number;
  errorCount: number;
  lastTrySecsAgo: number;
  nextTryInSecs: number;
};

type BlockVersion = {
  versionId: string;
  refDeleted: boolean;
  versionDeleted: boolean;
  garbageCollected: boolean;
};

type BlockInfo = {
  blockHash: string;
  refcount: number;
  versions: BlockVersion[];
};

type RetryBlocks = { all: true } | { blockHashes: [string] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerAtLeastZero(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function blockError(value: unknown): BlockError {
  if (!isRecord(value)) {
    throw new Error(unavailableMessage());
  }
  const blockHash = value.blockHash;
  const refcount = integerAtLeastZero(value.refcount);
  const errorCount = integerAtLeastZero(value.errorCount);
  const lastTrySecsAgo = integerAtLeastZero(value.lastTrySecsAgo);
  const nextTryInSecs = integerAtLeastZero(value.nextTryInSecs);
  if (
    typeof blockHash !== "string" ||
    blockHash.length === 0 ||
    refcount === null ||
    errorCount === null ||
    lastTrySecsAgo === null ||
    nextTryInSecs === null
  ) {
    throw new Error(unavailableMessage());
  }
  return { blockHash, refcount, errorCount, lastTrySecsAgo, nextTryInSecs };
}

function blockErrorsFrom(body: unknown): BlockError[] {
  if (!Array.isArray(body)) {
    throw new Error(unavailableMessage());
  }
  return body.map(blockError);
}

async function loadBlockErrors(nodeId: string): Promise<BlockError[]> {
  return blockErrorsFrom(
    await api<unknown>(`/api/nodes/${encodeURIComponent(nodeId)}/block-errors`),
  );
}

function blockVersion(value: unknown): BlockVersion {
  if (!isRecord(value)) {
    throw new Error(unavailableMessage());
  }
  const versionId = value.versionId;
  const refDeleted = value.refDeleted;
  const versionDeleted = value.versionDeleted;
  const garbageCollected = value.garbageCollected;
  if (
    typeof versionId !== "string" ||
    versionId.length === 0 ||
    typeof refDeleted !== "boolean" ||
    typeof versionDeleted !== "boolean" ||
    typeof garbageCollected !== "boolean"
  ) {
    throw new Error(unavailableMessage());
  }
  return { versionId, refDeleted, versionDeleted, garbageCollected };
}

function blockInfoFrom(body: unknown): BlockInfo {
  if (!isRecord(body) || !Array.isArray(body.versions)) {
    throw new Error(unavailableMessage());
  }
  const blockHash = body.blockHash;
  const refcount = integerAtLeastZero(body.refcount);
  if (typeof blockHash !== "string" || blockHash.length === 0 || refcount === null) {
    throw new Error(unavailableMessage());
  }
  return { blockHash, refcount, versions: body.versions.map(blockVersion) };
}

async function loadBlockInfo(nodeId: string, blockHash: string): Promise<BlockInfo> {
  return blockInfoFrom(
    await api<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/blocks/${encodeURIComponent(blockHash)}`,
    ),
  );
}

function yesNo(value: boolean): string {
  return value ? copy("ui.yes") : copy("ui.no");
}

function BlockInfoPanel({ nodeId, blockHash }: { nodeId: string; blockHash: string }) {
  const info = useQuery({
    queryKey: ["nodes", nodeId, "blocks", blockHash],
    queryFn: () => loadBlockInfo(nodeId, blockHash),
  });
  const message = info.error instanceof Error ? info.error.message : unavailableMessage();
  return (
    <>
      {info.isError && !isGarageDown(info.error) ? <p>{message}</p> : null}
      {info.data ? (
        <div className="ui-page">
          <h3>{copy("ui.block.information")}</h3>
          <ResourceIdentity id={info.data.blockHash} />
          <dl><dt>{copy("ui.refcount")}</dt><dd>{info.data.refcount}</dd></dl>
        <div className="ui-table-container" role="region" tabIndex={0} aria-label={copy("ui.block.information")}>
          <Table.Root className="ui-table ui-table-records" aria-label={copy("ui.block.information")}>
            <Table.Header>
              <Table.Row role="row">
                <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.version")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.ref.deleted")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                  {copy("ui.version.deleted")}</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="py-2 font-medium" scope="col">
                  {copy("ui.garbage.collected")}</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body role="rowgroup">
              {info.data.versions.map((version) => (
                <Table.Row key={version.versionId} role="row">
                  <DataCell label={copy("ui.version")} kind="identity">{version.versionId}</DataCell>
                  <DataCell label={copy("ui.ref.deleted")}>{yesNo(version.refDeleted)}</DataCell>
                  <DataCell label={copy("ui.version.deleted")}>{yesNo(version.versionDeleted)}</DataCell>
                  <DataCell label={copy("ui.garbage.collected")}>{yesNo(version.garbageCollected)}</DataCell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </div>
        </div>
      ) : null}
    </>
  );
}

function BlockErrorList({ nodeId }: { nodeId: string }) {
  const [purgeHash, setPurgeHash] = useState<string | null>(null);
  const [infoHash, setInfoHash] = useState<string | null>(null);
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["nodes", nodeId] });
  const blockErrors = useQuery({
    queryKey: ["nodes", nodeId, "block-errors"],
    queryFn: () => loadBlockErrors(nodeId),
  });
  const retry = useMutation({
    onSuccess: refresh,
    mutationFn: (command: RetryBlocks) =>
      api(`/api/nodes/${encodeURIComponent(nodeId)}/blocks/retry`, {
        method: "POST",
        body: JSON.stringify(command),
      }),
  });
  const purge = useMutation({
    onSuccess: async () => { await refresh(); setPurgeHash(null); },
    mutationFn: (hash: string) =>
      api(`/api/nodes/${encodeURIComponent(nodeId)}/blocks/purge`, {
        method: "POST",
        headers: { "x-confirm": "yes" },
        body: JSON.stringify([hash]),
      }),
  });
  const rows = blockErrors.data ?? [];
  const view = {
    busy: blockErrors.isPending,
    refreshing: rows.length > 0 && blockErrors.isFetching && !blockErrors.isPending,
    empty: Boolean(blockErrors.data) && rows.length === 0,
    failure: blockErrors.isError ? failureOf(blockErrors.error) : null,
  };

  return (
    <section className="ui-page" aria-label={copy("nav.blockErrors")} aria-busy={view.busy}>
      <header className="ui-page-header"><div><h2>{copy("nav.blockErrors")}</h2><ResourceIdentity id={nodeId} /></div></header>
      {view.busy ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.block.errors")}>{copy("ui.loading.block.errors")}</div>
      ) : null}
      {view.refreshing ? <p>{copy("ui.refreshing.block.errors")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void blockErrors.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {retry.error instanceof Error && !isGarageDown(retry.error) ? (
        <p>{retry.error.message}</p>
      ) : null}
      {purge.error instanceof Error && !isGarageDown(purge.error) ? (
        <p>{purge.error.message}</p>
      ) : null}
      {retry.isPending || purge.isPending ? <p role="status">{copy("ui.working")}</p> : null}
      {retry.isSuccess || purge.isSuccess ? <p role="status">{copy("ui.saved")}</p> : null}
      {view.empty ? <p>{copy("ui.there.are.no.block.errors")}</p> : null}
      {rows.length > 0 ? (
        <>
          <Button size="2" variant="soft" color="gray"
            type="button"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ all: true })}
          >
            {copy("ui.retry.all")}</Button>
          <div className="ui-table-container" role="region" tabIndex={0} aria-label={translate("Block error list")}>
            <Table.Root className="ui-table ui-table-records">
              <Table.Header>
                <Table.Row role="row">
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.block.hash")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.refcount")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.error.count")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.last.try.seconds.ago")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.next.try.in.seconds")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                    {copy("ui.retry")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 font-medium" scope="col">
                    {copy("ui.purge")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell className="py-2 pl-3 font-medium" scope="col">
                    {copy("ui.info")}</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body role="rowgroup">
                {rows.map((row) => (
                  <Table.Row key={row.blockHash} role="row">
                    <DataCell label={copy("ui.block.hash")} kind="identity">{row.blockHash}</DataCell>
                    <DataCell label={copy("ui.refcount")}>{row.refcount}</DataCell>
                    <DataCell label={copy("ui.error.count")}>{row.errorCount}</DataCell>
                    <DataCell label={copy("ui.last.try.seconds.ago")}>{row.lastTrySecsAgo}</DataCell>
                    <DataCell label={copy("ui.next.try.in.seconds")}>{row.nextTryInSecs}</DataCell>
                    <DataCell label={copy("ui.retry")} kind="actions">
                      <Button size="2" variant="soft" color="gray" aria-label={fill(copy("ui.retry.2"), { blockHash: row.blockHash })}
                        type="button"
                        disabled={retry.isPending}
            onClick={() => retry.mutate({ blockHashes: [row.blockHash] })}
                      >
                        {copy("ui.retry")}</Button>
                    </DataCell>
                    <DataCell label={copy("ui.purge")} kind="actions">
                      <Button size="2" variant="soft" color="red" aria-label={fill(copy("ui.purge.2"), { blockHash: row.blockHash })}
                        type="button"
                        disabled={purge.isPending}
                        onClick={() => {
                          setPurgeHash(row.blockHash);
                        }}
                      >
                        {copy("ui.purge")}</Button>
                    </DataCell>
                    <DataCell label={copy("ui.info")} kind="actions">
                      <Button size="2" variant="soft" color="gray" aria-label={fill(copy("ui.info.2"), { blockHash: row.blockHash })}
                        type="button"
                        onClick={() => {
                          setInfoHash(row.blockHash);
                        }}
                      >
                        {copy("ui.info")}</Button>
                    </DataCell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </div>
          {infoHash !== null ? <BlockInfoPanel nodeId={nodeId} blockHash={infoHash} /> : null}
        </>
      ) : null}
      {purgeHash !== null ? (
        <ConfirmDialog
          pending={purge.isPending}
          action="clear-block"
          name={purgeHash}
          scope={nodeId}
          consequence={`${copy("ui.object.data.will.be.lost")}${purge.error instanceof Error ? ` ${purge.error.message}` : ""}`}
          onCancel={() => {
            setPurgeHash(null);
          }}
          onConfirm={() => {
            const hash = purgeHash;
            purge.mutate(hash);
          }}
        />
      ) : null}
    </section>
  );
}

export function BlockErrors() {
  const [hash] = useLocationHash();
  const nodeId = blockErrorsNodeId(hash);
  if (nodeId === null) {
    return (
      <section className="ui-page" aria-label={copy("nav.blockErrors")} aria-busy={false}>
        <h2 className="text-lg font-semibold">{copy("nav.blockErrors")}</h2>
        <OperationNodeSelection route="block-errors" />
      </section>
    );
  }
  return <BlockErrorList nodeId={nodeId} />;
}
