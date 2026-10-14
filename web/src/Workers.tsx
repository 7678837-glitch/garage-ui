import { Button, Checkbox, Dialog, Select, Table, TextField } from "@radix-ui/themes";
import { OperationNodeSelection } from "./ClusterNodes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ApiError, api } from "./api/client";
import { ConfirmDialog } from "./confirm";
import { isGarageDown } from "./garageDown";
import { useLocationHash, workersNodeId } from "./Nav";
import { copy, fill, translate } from "./i18n";
import { DataCell } from "./ui";

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

function lastErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    throw new Error(unavailableMessage());
  }
  if (body.lastError === null) return null;
  if (!isRecord(body.lastError)) {
    throw new Error(unavailableMessage());
  }
  const message = body.lastError.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error(unavailableMessage());
  }
  return message;
}

async function loadWorkerMessage(nodeId: string, workerId: number): Promise<string | null> {
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
  const [editorOpen, setEditorOpen] = useState(false);
  const save = useMutation({
    onSuccess: () => { setOpen(false); setEditorOpen(false); },
    mutationFn: (assignment: VariableAssignment) => saveWorkerVariable(nodeId, assignment),
  });
  const ready = variable.length > 0 && value.length > 0 && !save.isPending;

  return (
    <div className="ui-form">
      <Dialog.Root open={editorOpen} onOpenChange={(next) => {
        if (!save.isPending && !open) setEditorOpen(next);
      }}>
        <Dialog.Trigger><Button type="button" size="2" variant="soft" color="gray">{copy("ui.save.variable")}</Button></Dialog.Trigger>
        <Dialog.Content maxWidth="440px"
          onEscapeKeyDown={(event) => { if (save.isPending || open) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (save.isPending || open) event.preventDefault(); }}>
          <Dialog.Title>{copy("ui.variable")}</Dialog.Title>
          <Dialog.Description size="2">{copy("ui.this.changes.a.worker.variable.on.the.node")}</Dialog.Description>
          <div className="ui-form">
            <label className="ui-field">
              <span className="text-sm">{copy("ui.variable")}</span>
              <TextField.Root size="2" disabled={save.isPending || open}
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
              <TextField.Root size="2" disabled={save.isPending || open}
                value={value}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            </label>
            <Button size="2" variant="solid" color="orange"
              type="button"
              disabled={!ready}
              onClick={() => {
                if (!ready) {
                  return;
                }
                setEditorOpen(false);
                setOpen(true);
              }}
            >
              {copy("ui.save.variable")}</Button>
            <div className="ui-actions">
              <Dialog.Close><Button type="button" size="2" variant="soft" color="gray" disabled={save.isPending || open}>{copy("ui.cancel")}</Button></Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Root>
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
            if (save.isPending) return;
            setOpen(false);
            setEditorOpen(true);
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
  const [editorOpen, setEditorOpen] = useState(false);
  const repair = useMutation({
    mutationFn: (body: RepairBody) => postRepair(nodeId, body),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["nodes", nodeId] }); setOpen(false); setEditorOpen(false); },
  });
  const failure = repair.error instanceof Error ? repair.error.message : copy("ui.repair.failed");

  return (
    <div className="ui-form">
      <Dialog.Root open={editorOpen} onOpenChange={(next) => {
        if (!repair.isPending && !open) setEditorOpen(next);
      }}>
        <Dialog.Trigger><Button type="button" size="2" variant="soft" color="gray">{copy("ui.start.repair")}</Button></Dialog.Trigger>
        <Dialog.Content maxWidth="440px"
          onEscapeKeyDown={(event) => { if (repair.isPending || open) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (repair.isPending || open) event.preventDefault(); }}>
          <Dialog.Title>{copy("ui.start.repair")}</Dialog.Title>
          <Dialog.Description size="2">{copy("ui.this.starts.a.repair.on.the.node")}</Dialog.Description>
          <div className="ui-form">
            <label className="ui-field">
              <span className="text-sm">{copy("ui.repair.type")}</span>
              <Select.Root size="2"
                value={option.value}
                disabled={repair.isPending || open}
                onValueChange={(value) => {
                  const next = REPAIR_OPTIONS.find((item) => item.value === value);
                  if (!next) {
                    return;
                  }
                  setOption(next);
                }}
              >
                <Select.Trigger aria-label={copy("ui.repair.type")} />
                <Select.Content>
                  {REPAIR_OPTIONS.map((item) => (
                    <Select.Item key={item.value} value={item.value}>{translate(item.label)}</Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
            <Button size="2" variant="solid" color="orange"
              type="button"
              disabled={repair.isPending}
              onClick={() => {
                setEditorOpen(false);
                setOpen(true);
              }}
            >
              {copy("ui.start.repair")}</Button>
            <div className="ui-actions">
              <Dialog.Close><Button type="button" size="2" variant="soft" color="gray" disabled={repair.isPending || open}>{copy("ui.cancel")}</Button></Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Root>
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
            if (repair.isPending) return;
            setOpen(false);
            setEditorOpen(true);
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

function WorkerDetail({ nodeId, worker, request, focusedRequest }: {
  nodeId: string;
  worker: WorkerRow;
  request: number;
  focusedRequest: MutableRefObject<number>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const detail = useQuery({
    queryKey: ["nodes", nodeId, "worker", worker.id],
    queryFn: () => loadWorkerMessage(nodeId, worker.id),
  });
  const label = `${fill(copy("ui.details.2"), { id: worker.id })}: ${worker.name}`;
  const failure = detail.isError ? failureOf(detail.error) : null;
  useEffect(() => {
    if (focusedRequest.current === request) return;
    focusedRequest.current = request;
    panel.current?.focus();
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [request, focusedRequest]);
  return (
    <div ref={panel} role="region" aria-label={label} tabIndex={-1} className="ui-worker-detail">
      <p className="font-medium">{label}</p>
      {detail.isPending ? <p role="status">{translate("Loading worker details")}</p> : null}
      {detail.isFetching && !detail.isPending ? <p role="status">{translate("Refreshing worker details")}</p> : null}
      {detail.data !== undefined ? <p role="status">{detail.data === null ? translate("No error reported") : detail.data}</p> : null}
      {failure ? <>
        <p role="alert">{failure.message}{failure.code ? ` ${failure.code}` : ""}</p>
        <Button size="2" variant="soft" color="gray" type="button" disabled={detail.isFetching} onClick={() => { void detail.refetch(); }}>
          {copy("ui.retry")}
        </Button>
      </> : null}
    </div>
  );
}

function WorkersList({ nodeId }: { nodeId: string }) {
  const [filter, setFilter] = useState<WorkerFilter>({ busyOnly: false, errorOnly: false });
  const [selected, setSelected] = useState<{ nodeId: string; workerId: number; request: number } | null>(null);
  const focusedRequest = useRef(0);
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
      <p className="ui-muted ui-identifier">{nodeId === "*" ? copy("operations.allNodes") : nodeId}</p>
      <div className="ui-toolbar text-sm">
        <label className="ui-checkbox-field">
          <Checkbox size="2"
            checked={filter.busyOnly}
            onCheckedChange={(checked) => setFilter((current) => ({ ...current, busyOnly: checked === true }))}
          />
          {copy("ui.busy.only")}</label>
        <label className="ui-checkbox-field">
          <Checkbox size="2"
            checked={filter.errorOnly}
            onCheckedChange={(checked) => setFilter((current) => ({ ...current, errorOnly: checked === true }))}
          />
          {copy("ui.errors.only")}</label>
      </div>
      <details className="ui-disclosure">
        <summary>{copy("tab.maintenance")}</summary>
        <div className="ui-actions">
          <NodeRepair nodeId={nodeId} />
          <WorkerVariable nodeId={nodeId} />
        </div>
      </details>
      {view.busy ? (
        <div className="h-16 border border-line" role="status" aria-label={copy("ui.loading.workers")}>{copy("ui.loading.workers")}</div>
      ) : null}
      {view.refreshing ? <p>{copy("ui.refreshing.workers")}</p> : null}
      {view.failure && !isGarageDown(view.failure) ? (
        <>
          <p>{view.failure.message}</p>
          {view.failure.code ? <p>{view.failure.code}</p> : null}
          <Button size="2" variant="soft" color="gray"
            type="button"
            onClick={() => {
              void workers.refetch();
            }}
          >
            {copy("ui.retry")}</Button>
        </>
      ) : null}
      {view.empty ? <p>{copy("ui.there.are.no.workers")}</p> : null}
      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.nodeId} className="grid gap-2">
            {nodeId === "*" ? <p className="ui-identifier">{group.nodeId}</p> : null}
            <div className="ui-table-container" role="region" tabIndex={0} aria-label={translate("Worker list")}>
              <Table.Root className="ui-table ui-table-records ui-workers-table">
                <Table.Header>
                  <Table.Row role="row">
                    <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.name")}</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.state")}</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.errors")}</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell className="py-2 pr-3 font-medium" scope="col">
                      {copy("ui.progress")}</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell className="relative py-2 font-medium" scope="col">
                      <span className="sr-only">{copy("ui.details")}</span>
                    </Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {group.rows.map((worker) => (
                    <Table.Row key={worker.id} role="row">
                      <DataCell label={copy("ui.name")} kind="identity">
                        <span className="block">{worker.name}</span>
                        <span className="block ui-muted ui-identifier">{translate("Worker ID")}: {worker.id}</span>
                      </DataCell>
                      <DataCell label={copy("ui.state")} className="ui-worker-state"><span className="ui-status">{worker.state}</span></DataCell>
                      <DataCell label={copy("ui.errors")} className="ui-worker-errors">{worker.errors}</DataCell>
                      <DataCell label={copy("ui.progress")} className={`ui-worker-progress${worker.progress.length === 0 ? " ui-worker-progress-empty" : ""}`}>{worker.progress}</DataCell>
                      <DataCell label={copy("ui.details")} kind="actions">
                        <Button size="2" variant="soft" color="gray"
                          type="button"
                          aria-label={`${fill(copy("ui.details.2"), { id: worker.id })}: ${worker.name}`}
                          aria-expanded={selected?.nodeId === group.nodeId && selected.workerId === worker.id}
                          onClick={() => {
                            setSelected((current) => ({ nodeId: group.nodeId, workerId: worker.id, request: (current?.request ?? 0) + 1 }));
                          }}
                        >
                          {copy("ui.details")}
                        </Button>
                        {selected?.nodeId === group.nodeId && selected.workerId === worker.id ? (
                          <WorkerDetail key={selected.request} nodeId={group.nodeId} worker={worker} request={selected.request} focusedRequest={focusedRequest} />
                        ) : null}
                      </DataCell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </div>
          </div>
        ),
      )}

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
