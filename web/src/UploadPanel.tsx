import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { putObject } from "./api/client";

// React 18 的 input 属性类型没有 webkitdirectory。目录选择只看这个属性在不在。
declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: T extends HTMLInputElement ? "" : never;
  }
}

const IN_FLIGHT_LIMIT = 3;

type Verdict = "pending" | "overwrite";

type Row = {
  id: number;
  name: string;
  file: File;
  verdict: Verdict;
  phase:
    | { kind: "queued" }
    | { kind: "uploading"; percent: number | null; rate: number | null; startedAt: number }
    | { kind: "done" }
    | { kind: "failed" }
    | { kind: "cancelled" };
};

const STATUS_LABEL = {
  queued: "Queued",
  uploading: "Uploading",
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

// 只拼相对路径。上传键仍走 objectKey。前导斜杠不能进对象键。
function dropRelativePath(parent: string, name: string): string {
  const joined = parent === "" ? name : `${parent}/${name}`;
  return joined.replace(/^\/+/, "");
}

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const collected: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries 一次只给一页，空列表才表示这个目录读完。
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
    // 浏览器里这个值是空字符串。没有该属性时同样视为空，避免 objectKey 读到 undefined。
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
  return keys.has(row.name) || sharesName(rows, row.name);
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
}: {
  bucketId: string;
  existingKeys: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef(rows);
  const abortRef = useRef(new Map<number, () => void>());
  const nextIdRef = useRef(1);
  const bucketRef = useRef(bucketId);
  const existingRef = useRef(existingKeys);
  bucketRef.current = bucketId;
  existingRef.current = existingKeys;
  rowsRef.current = rows;

  function commit(next: Row[]) {
    rowsRef.current = next;
    setRows(next);
  }

  function pump() {
    const current = rowsRef.current;
    const keys = new Set(existingRef.current);
    let slots = IN_FLIGHT_LIMIT - current.filter((row) => row.phase.kind === "uploading").length;
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
          ? { ...row, phase: { kind: "uploading", percent: 0, rate: null, startedAt: Date.now() } }
          : row,
      ),
    );
    for (const row of starting) {
      const handle = putObject({
        bucketId: bucketRef.current,
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
        () => finish(row.id, "done"),
        (error: unknown) => {
          if (!isAbort(error)) {
            finish(row.id, "failed");
          }
        },
      );
    }
  }

  function finish(id: number, kind: "done" | "failed") {
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
      void queryClient.invalidateQueries({ queryKey: ["bucket-objects", bucketId] });
    }
    pump();
  }

  function addFiles(list: File[], directory: boolean) {
    if (list.length === 0) {
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
    if (!row || (row.phase.kind !== "queued" && row.phase.kind !== "uploading")) {
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
        item.id === id ? { ...item, phase: { kind: "queued" } } : item,
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
        (item) => item.phase.kind === "queued" || item.phase.kind === "uploading",
      ),
    );
  }

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  useEffect(() => {
    pumpRef.current();
  }, [bucketId, existingKeys]);

  useEffect(() => {
    const busy = rows.some((row) => row.phase.kind === "queued" || row.phase.kind === "uploading");
    window.onbeforeunload = busy ? () => "" : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [rows]);

  const keys = new Set(existingKeys);

  function takeFiles(list: FileList | null, directory: boolean) {
    if (!list) {
      return;
    }
    addFiles(Array.from(list), directory);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    // DataTransferItem 离开这次事件就失效，entry 必须在这里同步取走。
    const entries = directoryEntries(event.dataTransfer);
    if (!entries) {
      takeFiles(event.dataTransfer.files, false);
      return;
    }
    void filesFromDrop(entries).then((files) => {
      addFiles(files, true);
    });
  }

  return (
    <section
      aria-label="Upload"
      className="grid gap-3"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <h2 className="text-lg font-semibold">Upload</h2>
      <p>Drop files here.</p>
      <label className="grid gap-1">
        Choose files
        <input
          className="border border-ink px-3 py-1"
          multiple
          type="file"
          onChange={(event) => {
            takeFiles(event.currentTarget.files, false);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <label className="grid gap-1">
        Choose folder
        <input
          className="border border-ink px-3 py-1"
          multiple
          type="file"
          webkitdirectory=""
          onChange={(event) => {
            takeFiles(event.currentTarget.files, true);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <button className="border border-ink px-3 py-1 text-left" type="button" onClick={clearFinished}>
        Clear finished
      </button>
      <ul className="grid gap-2">
        {rows.map((row) => {
          const prompt = row.phase.kind === "queued" && needsPrompt(row, rows, keys);
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-2">
              <span>{row.name}</span>
              <span>{STATUS_LABEL[row.phase.kind]}</span>
              {row.phase.kind === "uploading" && row.phase.percent !== null ? (
                <span>{row.phase.percent}%</span>
              ) : null}
              {row.phase.kind === "uploading" && row.phase.rate !== null ? (
                <span>{row.phase.rate} B/s</span>
              ) : null}
              {prompt ? (
                <>
                  <button
                    className="border border-ink px-3 py-1 text-left"
                    type="button"
                    onClick={() => {
                      overwrite(row.id, false);
                    }}
                  >
                    Overwrite
                  </button>
                  <button
                    className="border border-ink px-3 py-1 text-left"
                    type="button"
                    onClick={() => {
                      skip(row.id);
                    }}
                  >
                    Skip
                  </button>
                  <button
                    className="border border-ink px-3 py-1 text-left"
                    type="button"
                    onClick={() => {
                      overwrite(row.id, true);
                    }}
                  >
                    Overwrite all
                  </button>
                </>
              ) : null}
              {row.phase.kind === "queued" || row.phase.kind === "uploading" ? (
                <button
                  className="border border-ink px-3 py-1 text-left"
                  type="button"
                  onClick={() => {
                    cancel(row.id);
                  }}
                >
                  Cancel
                </button>
              ) : null}
              {row.phase.kind === "failed" || row.phase.kind === "cancelled" ? (
                <button
                  className="border border-ink px-3 py-1 text-left"
                  type="button"
                  onClick={() => {
                    retry(row.id);
                  }}
                >
                  Retry
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
