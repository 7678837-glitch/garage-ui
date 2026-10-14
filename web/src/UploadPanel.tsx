import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { setFormDirty } from "./unsaved";
import { ApiError, api, putObject } from "./api/client";
import { encodeObjectKey } from "./App";
import { useI18n, copy, translate } from "./i18n";

// React 18 input types omit webkitdirectory. Directory selection only checks that the attribute is present.
declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: T extends HTMLInputElement ? "" : never;
  }
}

const IN_FLIGHT_LIMIT = 3;

type Verdict = "pending" | "absent" | "exists" | "overwrite";

type Row = {
  id: number;
  name: string;
  file: File;
  verdict: Verdict;
  phase:
    | { kind: "queued" }
    | { kind: "checking" }
    | { kind: "uploading"; percent: number | null; rate: number | null; startedAt: number }
    | { kind: "done" }
    | { kind: "failed"; message?: string }
    | { kind: "cancelled" };
};

const STATUS_LABEL = {
  queued: "Queued",
  uploading: "Uploading",
  checking: "Checking destination",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

function objectKey(file: File, directory: boolean): string {
  const relative = file.webkitRelativePath;
  if (directory && relative !== "") {
    return relative;
  }
  return file.name;
}

// Join only the relative path. The upload key still goes through objectKey. A leading slash must not enter the object key.
function dropRelativePath(parent: string, name: string): string {
  const joined = parent === "" ? name : `${parent}/${name}`;
  return joined.replace(/^\/+/, "");
}

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const collected: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns one page. An empty list means this directory is finished.
    const pull = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        pull();
      }, reject);
    };
    pull();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function filesInDirectory(
  directory: FileSystemDirectoryEntry,
  parent: string,
): Promise<File[]> {
  const prefix = dropRelativePath(parent, directory.name);
  const children = await readDirectory(directory.createReader());
  const files: File[] = [];
  for (const child of children) {
    if (child.isDirectory) {
      files.push(...(await filesInDirectory(child as FileSystemDirectoryEntry, prefix)));
      continue;
    }
    if (!child.isFile) {
      continue;
    }
    const file = await fileFromEntry(child as FileSystemFileEntry);
    // Browsers use an empty string here. A missing property is treated the same way so objectKey does not read undefined.
    if (!file.webkitRelativePath) {
      Object.defineProperty(file, "webkitRelativePath", {
        value: dropRelativePath(prefix, child.name),
      });
    }
    files.push(file);
  }
  return files;
}

async function filesFromDrop(entries: readonly FileSystemEntry[]): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      files.push(...(await filesInDirectory(entry as FileSystemDirectoryEntry, "")));
      continue;
    }
    if (entry.isFile) {
      files.push(await fileFromEntry(entry as FileSystemFileEntry));
    }
  }
  return files;
}

function directoryEntries(transfer: DataTransfer): FileSystemEntry[] | null {
  const items = transfer.items;
  if (!items || items.length === 0) {
    return null;
  }
  const found: FileSystemEntry[] = [];
  let exposed = false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item.webkitGetAsEntry !== "function") {
      continue;
    }
    exposed = true;
    const entry = item.webkitGetAsEntry();
    if (entry) {
      found.push(entry);
    }
  }
  if (!exposed || !found.some((entry) => entry.isDirectory)) {
    return null;
  }
  return found;
}

function sharesName(rows: readonly Row[], name: string): boolean {
  let seen = 0;
  for (const row of rows) {
    if (row.name !== name) {
      continue;
    }
    seen += 1;
    if (seen > 1) {
      return true;
    }
  }
  return false;
}

function needsPrompt(row: Row, rows: readonly Row[], keys: ReadonlySet<string>): boolean {
  if (row.verdict === "overwrite") {
    return false;
  }
  return row.verdict === "exists" || keys.has(row.name) || sharesName(rows, row.name);
}

function canStart(row: Row, rows: readonly Row[], keys: ReadonlySet<string>): boolean {
  return row.phase.kind === "queued" && !needsPrompt(row, rows, keys);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function byteRate(percent: number | null, loaded: number, startedAt: number, now: number): number | null {
  if (percent === null || loaded <= 0) {
    return null;
  }
  const elapsed = now - startedAt;
  if (elapsed <= 0) {
    return null;
  }
  return Math.floor((loaded * 1000) / elapsed);
}

export function UploadPanel({
  bucketId,
  existingKeys,
  onActiveChange,
}: {
  bucketId: string;
  existingKeys: readonly string[];
  onActiveChange?: (count: number) => void;
}) {
  const queryClient = useQueryClient();
  const guardId = useId();
  const mounted = useRef(true);
  const dropGeneration = useRef(0);
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [pendingDrops, setPendingDrops] = useState(0);
  const [dropError, setDropError] = useState<string | null>(null);
  const rowsRef = useRef(rows);
  const abortRef = useRef(new Map<number, () => void>());
  const nextIdRef = useRef(1);
  const bucketRef = useRef(bucketId);
  const mountedBucket = useRef(bucketId);
  const existingRef = useRef(existingKeys);
  bucketRef.current = bucketId;
  existingRef.current = existingKeys;
  rowsRef.current = rows;

  function commit(next: Row[]) {
    if (!mounted.current) return;
    rowsRef.current = next;
    setRows(next);
  }

  function cancelAll() {
    dropGeneration.current += 1;
    const next = rowsRef.current.map((row): Row =>
      row.phase.kind === "uploading" || row.phase.kind === "checking" || row.phase.kind === "queued"
        ? { ...row, phase: { kind: "cancelled" } }
        : row,
    );
    rowsRef.current = next;
    for (const abort of abortRef.current.values()) abort();
    abortRef.current.clear();
    setFormDirty(guardId, false);
    window.onbeforeunload = null;
    if (mounted.current) {
      setRows(next);
      setPendingDrops(0);
    }
  }

  function pump() {
    if (!mounted.current || mountedBucket.current !== bucketRef.current) return;
    const current = rowsRef.current;
    const keys = new Set(existingRef.current);
    let slots = IN_FLIGHT_LIMIT - current.filter((row) => row.phase.kind === "uploading" || row.phase.kind === "checking").length;
    const starting: Row[] = [];
    for (const row of current) {
      if (slots <= 0) {
        break;
      }
      if (canStart(row, current, keys) && !abortRef.current.has(row.id)) {
        starting.push(row);
        slots -= 1;
      }
    }
    if (starting.length === 0) {
      return;
    }
    const ids = new Set(starting.map((row) => row.id));
    commit(
      current.map((row) =>
        ids.has(row.id)
          ? { ...row, phase: row.verdict === "pending" ? { kind: "checking" } : { kind: "uploading", percent: 0, rate: null, startedAt: Date.now() } }
          : row,
      ),
    );
    for (const row of starting) {
      const targetBucket = bucketRef.current;
      if (row.verdict === "pending") {
        const controller = new AbortController();
        const abort = () => controller.abort();
        abortRef.current.set(row.id, abort);
        void api<unknown>(`/api/buckets/${encodeURIComponent(targetBucket)}/objects/${encodeObjectKey(row.name)}`, { signal: controller.signal }).then(
          () => completeCheck("exists"),
          (error: unknown) => {
            if (error instanceof ApiError && error.code === "not_found") completeCheck("absent");
            else if (!isAbort(error)) completeCheck(null, error instanceof Error ? error.message : copy("ui.failed"));
          },
        );
        function completeCheck(verdict: "exists" | "absent" | null, message?: string) {
          if (!mounted.current || bucketRef.current !== targetBucket || abortRef.current.get(row.id) !== abort) return;
          abortRef.current.delete(row.id);
          commit(rowsRef.current.map((item) => item.id !== row.id || item.phase.kind !== "checking" ? item : {
            ...item, verdict: verdict ?? "pending", phase: verdict === null ? { kind: "failed", message } : { kind: "queued" },
          }));
          pump();
        }
        continue;
      }
      const handle = putObject({
        bucketId: targetBucket,
        key: row.name,
        body: row.file,
        contentType: row.file.type === "" ? "application/octet-stream" : row.file.type,
        onProgress({ percent, loaded }) {
          commit(
            rowsRef.current.map((item) => {
              if (item.id !== row.id || item.phase.kind !== "uploading") {
                return item;
              }
              return {
                ...item,
                phase: {
                  kind: "uploading",
                  percent,
                  startedAt: item.phase.startedAt,
                  rate: byteRate(percent, loaded, item.phase.startedAt, Date.now()),
                },
              };
            }),
          );
        },
      });
      abortRef.current.set(row.id, handle.abort);
      void handle.promise.then(
        () => finish(row.id, "done", targetBucket),
        (error: unknown) => {
          if (!isAbort(error)) {
            finish(row.id, "failed", targetBucket);
          }
        },
      );
    }
  }

  function finish(id: number, kind: "done" | "failed", targetBucket: string) {
    if (!mounted.current || bucketRef.current !== targetBucket) return;
    abortRef.current.delete(id);
    const row = rowsRef.current.find((item) => item.id === id);
    if (!row || row.phase.kind !== "uploading") {
      return;
    }
    commit(
      rowsRef.current.map((item) =>
        item.id === id ? { ...item, phase: { kind } } : item,
      ),
    );
    if (kind === "done") {
      void queryClient.invalidateQueries({ queryKey: ["bucket-objects", targetBucket] });
      void queryClient.invalidateQueries({ queryKey: ["bucket-object-search", targetBucket] });
      for (const family of ["bucket-object", "bucket-object-text", "bucket-object-inspect"]) {
        void queryClient.invalidateQueries({ queryKey: [family, targetBucket, row.name], exact: true });
      }
    }
    pump();
  }

  function addFiles(list: File[], directory: boolean) {
    if (!mounted.current || list.length === 0) {
      return;
    }
    const added = list.map((file) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const row: Row = {
        id,
        name: objectKey(file, directory),
        file,
        verdict: "pending",
        phase: { kind: "queued" },
      };
      return row;
    });
    commit([...rowsRef.current, ...added]);
    pump();
  }

  function cancel(id: number) {
    const row = rowsRef.current.find((item) => item.id === id);
    if (!row || (row.phase.kind !== "queued" && row.phase.kind !== "uploading" && row.phase.kind !== "checking")) {
      return;
    }
    abortRef.current.get(id)?.();
    abortRef.current.delete(id);
    commit(
      rowsRef.current.map((item) =>
        item.id === id ? { ...item, phase: { kind: "cancelled" } } : item,
      ),
    );
    pump();
  }

  function retry(id: number) {
    const row = rowsRef.current.find((item) => item.id === id);
    if (!row || (row.phase.kind !== "failed" && row.phase.kind !== "cancelled")) {
      return;
    }
    abortRef.current.delete(id);
    commit(
      rowsRef.current.map((item) =>
        item.id === id ? { ...item, verdict: item.verdict === "overwrite" ? "overwrite" : "pending", phase: { kind: "queued" } } : item,
      ),
    );
    pump();
  }

  function skip(id: number) {
    abortRef.current.delete(id);
    commit(rowsRef.current.filter((item) => item.id !== id));
    pump();
  }

  function overwrite(id: number, all: boolean) {
    const name = rowsRef.current.find((item) => item.id === id)?.name;
    if (!name) {
      return;
    }
    commit(
      rowsRef.current.map((item) =>
        item.id === id || (all && item.name === name) ? { ...item, verdict: "overwrite" } : item,
      ),
    );
    pump();
  }

  function clearFinished() {
    commit(
      rowsRef.current.filter(
        (item) => item.phase.kind === "queued" || item.phase.kind === "uploading" || item.phase.kind === "checking",
      ),
    );
  }

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  useEffect(() => {
    if (mountedBucket.current !== bucketId) {
      cancelAllRef.current();
      mountedBucket.current = bucketId;
      commit([]);
    }
    pumpRef.current();
  }, [bucketId, existingKeys]);

  const cancelAllRef = useRef(cancelAll);
  cancelAllRef.current = cancelAll;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAllRef.current();
    };
  }, []);

  useEffect(() => {
    const busy = pendingDrops > 0 || rows.some((row) => row.phase.kind === "queued" || row.phase.kind === "uploading" || row.phase.kind === "checking");
    setFormDirty(guardId, busy, () => cancelAllRef.current());
    window.onbeforeunload = busy ? () => "" : null;
    return () => {
      setFormDirty(guardId, false);
      window.onbeforeunload = null;
    };
  }, [guardId, pendingDrops, rows]);

  const activeCount = pendingDrops + rows.filter((row) => row.phase.kind === "queued" || row.phase.kind === "uploading" || row.phase.kind === "checking").length;
  useEffect(() => {
    onActiveChange?.(activeCount);
  }, [activeCount, onActiveChange]);

  const keys = new Set(existingKeys);

  function takeFiles(list: FileList | null, directory: boolean) {
    if (!list) {
      return;
    }
    addFiles(Array.from(list), directory);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    // A DataTransferItem expires when this event returns, so the entry has to be read here.
    const entries = directoryEntries(event.dataTransfer);
    if (!entries) {
      takeFiles(event.dataTransfer.files, false);
      return;
    }
    const generation = dropGeneration.current;
    setPendingDrops((current) => current + 1);
    setDropError(null);
    void filesFromDrop(entries).then(
      (files) => {
        if (generation !== dropGeneration.current || !mounted.current) return;
        setPendingDrops((current) => current - 1);
        addFiles(files, true);
      },
      (error: unknown) => {
        if (generation !== dropGeneration.current || !mounted.current) return;
        setPendingDrops((current) => current - 1);
        setDropError(error instanceof Error ? error.message : copy("ui.failed"));
      },
    );
  }

  return (
    <section
      aria-label={copy("ui.upload")}
      className="ui-form"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <p className="ui-muted">{copy("ui.drop.files.here")}</p>
      {pendingDrops > 0 ? <div className="ui-actions">
        <span className="ui-status">{copy("ui.queued")} · {pendingDrops}</span>
        <button className="ui-button" type="button" onClick={cancelAll}>{copy("ui.cancel")}</button>
      </div> : null}
      {dropError !== null ? <p className="ui-alert" role="alert">{dropError}</p> : null}
      <div className="ui-toolbar items-end">
      <label className="ui-field flex-1">
        {copy("ui.choose.files")}<input
          className="ui-input w-full min-w-0 max-w-full"
          multiple
          type="file"
          onChange={(event) => {
            takeFiles(event.currentTarget.files, false);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <label className="ui-field">
        {copy("ui.choose.folder")}<input
          className="ui-input w-full min-w-0 max-w-full"
          multiple
          type="file"
          webkitdirectory=""
          onChange={(event) => {
            takeFiles(event.currentTarget.files, true);
            event.currentTarget.value = "";
          }}
        />
      </label>
      </div>
      <button className="ui-button" type="button" onClick={clearFinished}>
        {copy("ui.clear.finished")}</button>
      <ul className="grid gap-2" aria-live="polite">
        {rows.map((row) => {
          const prompt = row.phase.kind === "queued" && needsPrompt(row, rows, keys);
          return (
            <li key={row.id} className="ui-actions border-b border-line py-2">
              <span className="ui-identifier flex-1" title={row.name}>{row.name}</span>
              <span className="ui-status">{row.phase.kind === "checking" ? copy("ui.checking.destination") : translate(STATUS_LABEL[row.phase.kind])}</span>
              {row.phase.kind === "failed" && row.phase.message ? <span role="alert" className="ui-alert">{row.phase.message}</span> : null}
              {row.phase.kind === "uploading" && row.phase.percent !== null ? (
                <span>{row.phase.percent}%</span>
              ) : null}
              {row.phase.kind === "uploading" && row.phase.rate !== null ? (
                <span>
                  {row.phase.rate} {t("unit.perSecond")}
                </span>
              ) : null}
              {prompt ? (
                <>
                  <button
                    className="ui-button"
                    type="button"
                    onClick={() => {
                      overwrite(row.id, false);
                    }}
                  >
                    {copy("ui.overwrite")}</button>
                  <button
                    className="ui-button"
                    type="button"
                    onClick={() => {
                      skip(row.id);
                    }}
                  >
                    {copy("ui.skip")}</button>
                  <button
                    className="ui-button"
                    type="button"
                    onClick={() => {
                      overwrite(row.id, true);
                    }}
                  >
                    {copy("ui.overwrite.all")}</button>
                </>
              ) : null}
              {row.phase.kind === "queued" || row.phase.kind === "uploading" || row.phase.kind === "checking" ? (
                <button
                  className="ui-button"
                  type="button"
                  onClick={() => {
                    cancel(row.id);
                  }}
                >
                  {copy("ui.cancel")}</button>
              ) : null}
              {row.phase.kind === "failed" || row.phase.kind === "cancelled" ? (
                <button
                  className="ui-button"
                  type="button"
                  onClick={() => {
                    retry(row.id);
                  }}
                >
                  {copy("ui.retry")}</button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
