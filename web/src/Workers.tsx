import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";
import { useLocationHash, workersNodeId } from "./Nav";

const UNAVAILABLE = "Workers are unavailable";

type WorkerRow = {
  id: number;
  name: string;
  state: string;
  errors: number;
  progress: string;
};

type WorkerFilter = {
  busyOnly: boolean;
  errorOnly: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerAtLeastZero(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function stateText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (!isRecord(value) || !isRecord(value.throttled)) {
    return null;
  }
  const duration = value.throttled.durationSecs;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return null;
  }
  return "throttled";
}

function workerRow(value: unknown): WorkerRow {
  if (!isRecord(value)) {
    throw new Error(UNAVAILABLE);
  }
  const id = integerAtLeastZero(value.id);
  const errors = integerAtLeastZero(value.errors);
  const state = stateText(value.state);
  const name = value.name;
  const progress = value.progress;
  if (
    id === null ||
    errors === null ||
    state === null ||
    typeof name !== "string" ||
    name.length === 0
  ) {
    throw new Error(UNAVAILABLE);
  }
  if (progress !== undefined && progress !== null && typeof progress !== "string") {
    throw new Error(UNAVAILABLE);
  }
  return {
    id,
    name,
    state,
    errors,
    progress: typeof progress === "string" ? progress : "",
  };
}

function workersFrom(body: unknown): WorkerRow[] {
  if (!Array.isArray(body)) {
    throw new Error(UNAVAILABLE);
  }
  return body.map(workerRow);
}

function workersPath(nodeId: string, filter: WorkerFilter): string {
  const params = new URLSearchParams();
  if (filter.busyOnly) {
    params.set("busy", "1");
  }
  if (filter.errorOnly) {
    params.set("errors", "1");
  }
  const query = params.toString();
  const path = `/api/nodes/${encodeURIComponent(nodeId)}/workers`;
  if (query.length === 0) {
    return path;
  }
  return `${path}?${query}`;
}

async function loadWorkers(nodeId: string, filter: WorkerFilter): Promise<WorkerRow[]> {
  return workersFrom(await api<unknown>(workersPath(nodeId, filter)));
}

const REPAIR_KINDS = [
  "tables",
  "blocks",
  "versions",
  "multipartUploads",
  "blockRefs",
  "blockRc",
  "rebalance",
  "aliases",
  "clearResyncQueue",
] as const;

const SCRUB_COMMANDS = ["start", "pause", "resume", "cancel"] as const;

type RepairKind = (typeof REPAIR_KINDS)[number];
type ScrubCommand = (typeof SCRUB_COMMANDS)[number];

type RepairBody = { repairType: RepairKind } | { repairType: { scrub: ScrubCommand } };

type RepairOption = {
  value: string;
  label: string;
  body: RepairBody;
};

function kindOption(kind: RepairKind): RepairOption {
  return { value: kind, label: kind, body: { repairType: kind } };
}

function scrubOption(command: ScrubCommand): RepairOption {
  return {
    value: `scrub:${command}`,
    label: `scrub ${command}`,
    body: { repairType: { scrub: command } },
  };
}

const REPAIR_OPTIONS = [
  ...REPAIR_KINDS.map(kindOption),
  ...SCRUB_COMMANDS.map(scrubOption),
] as const;

function postRepair(nodeId: string, body: RepairBody): Promise<unknown> {
  return api(`/api/nodes/${encodeURIComponent(nodeId)}/repair`, {
    method: "POST",
    headers: { "x-confirm": "yes" },
    body: JSON.stringify(body),
  });
}

function NodeRepair({ nodeId }: { nodeId: string }) {
  const [option, setOption] = useState<RepairOption>(REPAIR_OPTIONS[0]);
  const [open, setOpen] = useState(false);
  const repair = useMutation({
    mutationFn: (body: RepairBody) => postRepair(nodeId, body),
  });
  const failure = repair.error instanceof Error ? repair.error.message : "Repair failed";

  return (
    <div className="grid max-w-sm gap-3">
      <label className="block">
        <span className="text-sm">Repair type</span>
        <select
          className="mt-1 w-full border border-line px-2 py-1"
          value={option.value}
          onChange={(event) => {
            const next = REPAIR_OPTIONS.find((item) => item.value === event.target.value);
            if (!next) {
              return;
            }
            setOption(next);
          }}
        >
          {REPAIR_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <button
        className="border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Start repair
      </button>
      {repair.isError ? <p>{failure}</p> : null}
      {repair.isSuccess ? <p>Repair started.</p> : null}
      {open ? (
        <ConfirmDialog
          action="repair"
          name={nodeId}
          scope={option.label}
          consequence="This starts a repair on the node."
          onCancel={() => {
            setOpen(false);
          }}
          onConfirm={() => {
            const body = option.body;
            setOpen(false);
            repair.mutate(body);
          }}
        />
      ) : null}
    </div>
  );
}

function WorkersList({ nodeId }: { nodeId: string }) {
  const [filter, setFilter] = useState<WorkerFilter>({ busyOnly: false, errorOnly: false });
  const workers = useQuery({
    queryKey: ["nodes", nodeId, "workers", filter.busyOnly, filter.errorOnly],
    queryFn: () => loadWorkers(nodeId, filter),
  });
  const message = workers.error instanceof Error ? workers.error.message : UNAVAILABLE;
  const rows = workers.data ?? [];

  return (
    <>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filter.busyOnly}
            onChange={(event) => {
              setFilter((current) => ({ ...current, busyOnly: event.target.checked }));
            }}
          />
          Busy only
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filter.errorOnly}
            onChange={(event) => {
              setFilter((current) => ({ ...current, errorOnly: event.target.checked }));
            }}
          />
          Errors only
        </label>
      </div>
      {workers.isPending ? (
        <div className="h-16 border border-line" aria-label="Loading workers" />
      ) : null}
      {workers.isError && !isGarageDown(workers.error) ? (
        <>
          <p>{message}</p>
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void workers.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {workers.isSuccess && rows.length === 0 ? <p>There are no workers.</p> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Name
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  State
                </th>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Errors
                </th>
                <th className="py-2 font-medium" scope="col">
                  Progress
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((worker) => (
                <tr key={worker.id}>
                  <td className="py-2 pr-3">{worker.name}</td>
                  <td className="py-2 pr-3">{worker.state}</td>
                  <td className="py-2 pr-3">{worker.errors}</td>
                  <td className="py-2">{worker.progress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

export function Workers() {
  const [hash] = useLocationHash();
  const nodeId = workersNodeId(hash);
  return (
    <section className="grid gap-4" aria-label="Workers">
      <h2 className="text-lg font-semibold">Workers</h2>
      {nodeId === null ? (
        <p>No node is selected.</p>
      ) : (
        <>
          <NodeRepair nodeId={nodeId} />
          <WorkersList nodeId={nodeId} />
        </>
      )}
    </section>
  );
}
