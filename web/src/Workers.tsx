import { OperationNodeSelection } from "./ClusterNodes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";
import { useLocationHash, workersNodeId } from "./Nav";
import { copy, fill, translate } from "./i18n";

function unavailableMessage(): string {
  return copy("ui.workers.are.unavailable");
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
    throw new Error(unavailableMessage());
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
    throw new Error(unavailableMessage());
  }
  if (progress !== undefined && progress !== null && typeof progress !== "string") {
    throw new Error(unavailableMessage());
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
    throw new Error(unavailableMessage());
  }
  return body.map(workerRow);
}

function lastErrorMessage(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.lastError)) {
    throw new Error(unavailableMessage());
  }
  const message = body.lastError.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error(unavailableMessage());
  }
  return message;
}

async function loadWorkerMessage(nodeId: string, workerId: number): Promise<string> {
  const body = await api<unknown>(
    `/api/nodes/${encodeURIComponent(nodeId)}/workers/${workerId}`,
  );
  return lastErrorMessage(body);
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

type WorkerGroup = {
  nodeId: string;
  rows: WorkerRow[];
};

function workerGroups(nodeId: string, body: unknown): WorkerGroup[] {
  if (nodeId !== "*") {
    return [{ nodeId, rows: workersFrom(body) }];
  }
  if (!isRecord(body)) {
    throw new Error(unavailableMessage());
  }
  return Object.entries(body).map(([id, rows]) => ({
    nodeId: id,
    rows: workersFrom(rows),
  }));
}

async function loadWorkers(nodeId: string, filter: WorkerFilter): Promise<WorkerGroup[]> {
  return workerGroups(nodeId, await api<unknown>(workersPath(nodeId, filter)));
}

type VariableAssignment = {
  variable: string;
  value: string;
};

function variableSentence(variable: string, body: unknown): string {
  if (!isRecord(body)) {
    throw new Error(unavailableMessage());
  }
  const found = body[variable];
  if (typeof found !== "string") {
    throw new Error(unavailableMessage());
  }
  return fill(copy("ui.variable.is"), { variable: variable, found: found });
}

async function saveWorkerVariable(nodeId: string, assignment: VariableAssignment): Promise<string> {
  await api(`/api/nodes/${encodeURIComponent(nodeId)}/worker-variables`, {
    method: "PUT",
    headers: { "x-confirm": "yes" },
    body: JSON.stringify({ variable: assignment.variable, value: assignment.value }),
  });
  const body = await api<unknown>(
    `/api/nodes/${encodeURIComponent(nodeId)}/worker-variables?variable=${encodeURIComponent(assignment.variable)}`,
  );
  return variableSentence(assignment.variable, body);
}

function WorkerVariable({ nodeId }: { nodeId: string }) {
  const [variable, setVariable] = useState("");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const save = useMutation({
    onSuccess: () => setOpen(false),
    mutationFn: (assignment: VariableAssignment) => saveWorkerVariable(nodeId, assignment),
  });
  const ready = variable.length > 0 && value.length > 0 && !save.isPending;

  return (
    <div className="ui-form max-w-sm">
      <label className="ui-field">
        <span className="text-sm">{copy("ui.variable")}</span>
        <input
          className="ui-input"
          value={variable}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setVariable(event.target.value);
          }}
        />
      </label>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.value")}</span>
        <input
          className="ui-input"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
      <button
        className="ui-button"
        type="button"
        disabled={!ready}
        onClick={() => {
          if (!ready) {
            return;
          }
          setOpen(true);
        }}
      >
        {copy("ui.save.variable")}</button>
      {save.error instanceof Error ? <p role="alert">{save.error.message}</p> : null}
      {save.isPending ? <p role="status">{copy("ui.working")}</p> : null}
      {save.data !== undefined ? <p>{save.data}</p> : null}
      {open ? (
        <ConfirmDialog
          pending={save.isPending}
          action="worker-variable"
          name={variable}
          scope={value}
          consequence={`${copy("ui.this.changes.a.worker.variable.on.the.node")}${save.error instanceof Error ? ` ${save.error.message}` : ""}`}
          onCancel={() => {
            setOpen(false);
          }}
          onConfirm={() => {
            const assignment = { variable, value };
            save.mutate(assignment);
          }}
        />
      ) : null}
    </div>
  );
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

function scrubLabel(command: ScrubCommand): string {
  if (command === "start") return "scrub start";
  if (command === "pause") return "scrub pause";
  if (command === "resume") return "scrub resume";
  return "scrub cancel";
}

function scrubOption(command: ScrubCommand): RepairOption {
  return {
    value: `scrub:${command}`,
    label: scrubLabel(command),
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
  const client = useQueryClient();
  const [option, setOption] = useState<RepairOption>(REPAIR_OPTIONS[0]);
  const [open, setOpen] = useState(false);
  const repair = useMutation({
    mutationFn: (body: RepairBody) => postRepair(nodeId, body),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["nodes", nodeId] }); setOpen(false); },
  });
  const failure = repair.error instanceof Error ? repair.error.message : copy("ui.repair.failed");

  return (
    <div className="ui-form max-w-sm">
      <label className="ui-field">
        <span className="text-sm">{copy("ui.repair.type")}</span>
        <select
          className="ui-input"
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
              {translate(item.label)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="ui-button"
        type="button"
        disabled={repair.isPending}
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy("ui.start.repair")}</button>
      {repair.isPending ? <p role="status">{copy("ui.working")}</p> : null}
      {repair.isError ? <p>{failure}</p> : null}
      {repair.isSuccess ? <p>{copy("ui.repair.started")}</p> : null}
      {open ? (
        <ConfirmDialog
          pending={repair.isPending}
          action="repair"
          name={nodeId}
          scope={translate(option.label)}
          consequence={`${copy("ui.this.starts.a.repair.on.the.node")}${repair.error instanceof Error ? ` ${repair.error.message}` : ""}`}
          onCancel={() => {
            setOpen(false);
          }}
          onConfirm={() => {
            const body = option.body;
            repair.mutate(body);
          }}
        />
      ) : null}
    </div>
  );
}

function WorkerDetail({ nodeId, workerId }: { nodeId: string; workerId: number }) {
  const detail = useQuery({
    queryKey: ["nodes", nodeId, "worker", workerId],
    queryFn: () => loadWorkerMessage(nodeId, workerId),
  });
  if (detail.data === undefined) {
    return null;
  }
  return <p>{detail.data}</p>;
}

function WorkersList({ nodeId }: { nodeId: string }) {
  const [filter, setFilter] = useState<WorkerFilter>({ busyOnly: false, errorOnly: false });
  const [selected, setSelected] = useState<{ nodeId: string; workerId: number } | null>(null);
  const workers = useQuery({
    queryKey: ["nodes", nodeId, "workers", filter.busyOnly, filter.errorOnly],
    queryFn: () => loadWorkers(nodeId, filter),
  });
  const groups = workers.data ?? [];
  const rowCount = groups.reduce((count, group) => count + group.rows.length, 0);
  const view = {
    busy: workers.isPending,
    refreshing: rowCount > 0 && workers.isFetching && !workers.isPending,
    empty: Boolean(workers.data) && rowCount === 0,
    failure: workers.isError ? failureOf(workers.error) : null,
  };

  return (
    <section className="ui-page" aria-label={copy("nav.workers")} aria-busy={view.busy}>
      <h2 className="text-lg font-semibold">{copy("nav.workers")}</h2>
      <div className="ui-toolbar text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filter.busyOnly}
            onChange={(event) => {
              setFilter((current) => ({ ...current, busyOnly: event.target.checked }));
            }}
          />
          {copy("ui.busy.only")}</label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filter.errorOnly}
            onChange={(event) => {
              setFilter((current) => ({ ...current, errorOnly: event.target.checked }));
            }}
          />
          {copy("ui.errors.only")}</label>
      </div>
      {view.busy ? (
        <div className="h-16 border border-line" aria-label={copy("ui.loading.workers")} />
      ) : null}
      {view.refreshing ? <p>{copy("ui.refreshing.workers")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void workers.refetch();
            }}
          >
            {copy("ui.retry")}</button>
        </>
      ) : null}
      {view.empty ? <p>{copy("ui.there.are.no.workers")}</p> : null}
      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.nodeId} className="grid gap-2">
            {nodeId === "*" ? <p>{group.nodeId}</p> : null}
            <div className="ui-table-container" role="region" tabIndex={0} aria-label={translate("Worker list")}>
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.name")}</th>
                    <th className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.state")}</th>
                    <th className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.errors")}</th>
                    <th className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.progress")}</th>
                    <th className="py-2 font-medium" scope="col">
                      <span className="sr-only">{copy("ui.details")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((worker) => (
                    <tr key={worker.id}>
                      <td className="py-2 pr-3">{worker.name}</td>
                      <td className="py-2 pr-3">{worker.state}</td>
                      <td className="py-2 pr-3">{worker.errors}</td>
                      <td className="py-2 pr-3">{worker.progress}</td>
                      <td className="py-2">
                        <button
                          className="ui-button"
                          type="button"
                          onClick={() => {
                            setSelected({ nodeId: group.nodeId, workerId: worker.id });
                          }}
                        >
                          {fill(copy("ui.details.2"), { id: worker.id })}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ),
      )}
      <details className="ui-disclosure"><summary>{copy("ui.start.repair")}</summary><NodeRepair nodeId={nodeId} /></details>
      <details className="ui-disclosure"><summary>{copy("ui.variable")}</summary><WorkerVariable nodeId={nodeId} /></details>
      {selected !== null ? (
        <WorkerDetail nodeId={selected.nodeId} workerId={selected.workerId} />
      ) : null}
    </section>
  );
}

export function Workers() {
  const [hash] = useLocationHash();
  const nodeId = workersNodeId(hash);
  if (nodeId === null) {
    return (
      <section className="ui-page" aria-label={copy("nav.workers")} aria-busy={false}>
        <h2 className="text-lg font-semibold">{copy("nav.workers")}</h2>
        <OperationNodeSelection route="workers" all />
      </section>
    );
  }
  return <WorkersList nodeId={nodeId} />;
}
