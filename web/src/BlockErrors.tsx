import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";
import { blockErrorsNodeId, useLocationHash } from "./Nav";

const UNAVAILABLE = "Block errors are unavailable";

type BlockError = {
  blockHash: string;
  refcount: number;
  errorCount: number;
  lastTrySecsAgo: number;
  nextTryInSecs: number;
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
    throw new Error(UNAVAILABLE);
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
    throw new Error(UNAVAILABLE);
  }
  return { blockHash, refcount, errorCount, lastTrySecsAgo, nextTryInSecs };
}

function blockErrorsFrom(body: unknown): BlockError[] {
  if (!Array.isArray(body)) {
    throw new Error(UNAVAILABLE);
  }
  return body.map(blockError);
}

async function loadBlockErrors(nodeId: string): Promise<BlockError[]> {
  return blockErrorsFrom(
    await api<unknown>(`/api/nodes/${encodeURIComponent(nodeId)}/block-errors`),
  );
}

function BlockErrorList({ nodeId }: { nodeId: string }) {
  const [purgeHash, setPurgeHash] = useState<string | null>(null);
  const blockErrors = useQuery({
    queryKey: ["nodes", nodeId, "block-errors"],
    queryFn: () => loadBlockErrors(nodeId),
  });
  const retry = useMutation({
    mutationFn: (command: RetryBlocks) =>
      api(`/api/nodes/${encodeURIComponent(nodeId)}/blocks/retry`, {
        method: "POST",
        body: JSON.stringify(command),
      }),
  });
  const purge = useMutation({
    mutationFn: (hash: string) =>
      api(`/api/nodes/${encodeURIComponent(nodeId)}/blocks/purge`, {
        method: "POST",
        headers: { "x-confirm": "yes" },
        body: JSON.stringify([hash]),
      }),
  });
  const message = blockErrors.error instanceof Error ? blockErrors.error.message : UNAVAILABLE;
  const rows = blockErrors.data ?? [];

  return (
    <>
      {blockErrors.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading block errors" />
      ) : null}
      {blockErrors.isError && !isGarageDown(blockErrors.error) ? <p>{message}</p> : null}
      {retry.error instanceof Error && !isGarageDown(retry.error) ? (
        <p>{retry.error.message}</p>
      ) : null}
      {purge.error instanceof Error && !isGarageDown(purge.error) ? (
        <p>{purge.error.message}</p>
      ) : null}
      {blockErrors.isSuccess && rows.length === 0 ? <p>There are no block errors.</p> : null}
      {rows.length > 0 ? (
        <>
          <button
            className="w-fit border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => retry.mutate({ all: true })}
          >
            Retry all
          </button>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Block hash
                  </th>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Refcount
                  </th>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Error count
                  </th>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Last try seconds ago
                  </th>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Next try in seconds
                  </th>
                  <th className="py-2 pr-3 font-medium" scope="col">
                    Retry
                  </th>
                  <th className="py-2 font-medium" scope="col">
                    Purge
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.blockHash}>
                    <td className="py-2 pr-3">{row.blockHash}</td>
                    <td className="py-2 pr-3">{row.refcount}</td>
                    <td className="py-2 pr-3">{row.errorCount}</td>
                    <td className="py-2 pr-3">{row.lastTrySecsAgo}</td>
                    <td className="py-2 pr-3">{row.nextTryInSecs}</td>
                    <td className="py-2 pr-3">
                      <button
                        className="border border-ink px-3 py-1 text-left"
                        type="button"
                        onClick={() => retry.mutate({ blockHashes: [row.blockHash] })}
                      >
                        Retry {row.blockHash}
                      </button>
                    </td>
                    <td className="py-2">
                      <button
                        className="border border-ink px-3 py-1 text-left"
                        type="button"
                        onClick={() => {
                          setPurgeHash(row.blockHash);
                        }}
                      >
                        Purge {row.blockHash}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {purgeHash !== null ? (
        <ConfirmDialog
          action="clear-block"
          name={purgeHash}
          scope={nodeId}
          consequence="Object data will be lost."
          onCancel={() => {
            setPurgeHash(null);
          }}
          onConfirm={() => {
            const hash = purgeHash;
            setPurgeHash(null);
            purge.mutate(hash);
          }}
        />
      ) : null}
    </>
  );
}

export function BlockErrors() {
  const [hash] = useLocationHash();
  const nodeId = blockErrorsNodeId(hash);
  return (
    <section className="grid gap-4" aria-label="Block errors">
      <h2 className="text-lg font-semibold">Block errors</h2>
      {nodeId === null ? <p>No node is selected.</p> : <BlockErrorList nodeId={nodeId} />}
    </section>
  );
}
