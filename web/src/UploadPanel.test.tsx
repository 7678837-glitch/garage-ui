import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as renderTree, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hashForObjects } from "./Nav";
import { Objects } from "./Objects";
import { UploadPanel } from "./UploadPanel";
import { releaseHash, setFormDirty } from "./unsaved";

type Progress = { lengthComputable: boolean; loaded: number; total: number };

class FakeRequest {
  static sent: FakeRequest[] = [];

  method = "";
  url = "";
  withCredentials = false;
  aborted = false;
  status = 0;
  responseText = "";
  headers = new Map<string, string>();
  body: Document | XMLHttpRequestBodyInit | null = null;
  upload: { onprogress: ((event: Progress) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
    FakeRequest.sent.push(this);
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  emitProgress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total });
  }

  succeed() {
    this.status = 204;
    this.onload?.();
  }

  fail() {
    this.status = 500;
    this.onload?.();
  }
}

beforeEach(() => {
  FakeRequest.sent = [];
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.onbeforeunload = null;
  document.cookie = "garage_csrf=; Max-Age=0";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function choose(names: readonly string[], type = "text/plain") {
  const input = screen.getByLabelText("Choose files");
  const files = names.map(
    (name, index) => new File([`body-${index}`], name, { type }),
  );
  fireEvent.change(input, { target: { files } });
  return files;
}

function row(name: string): HTMLElement {
  const item = screen.getByText(name).closest("li");
  if (!(item instanceof HTMLElement)) {
    throw new Error(`missing row ${name}`);
  }
  return item;
}

function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderTree(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

test("keeps a fourth file queued until an upload slot frees", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  expect(FakeRequest.sent.map((request) => request.url)).toEqual([
    "/api/buckets/bkt-1/objects/a.txt",
    "/api/buckets/bkt-1/objects/b.txt",
    "/api/buckets/bkt-1/objects/c.txt",
  ]);
  expect(row("a.txt").textContent).toContain("Uploading");
  expect(row("a.txt").textContent).toContain("0%");
  expect(row("d.txt").textContent).toContain("Queued");
  expect(row("d.txt").textContent).not.toContain("Uploading");
  expect(window.onbeforeunload).not.toBeNull();
  act(() => {
    FakeRequest.sent[0]?.emitProgress(40, 100);
  });
  expect(row("a.txt").textContent).toContain("40%");
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(FakeRequest.sent.map((request) => request.url)).toEqual([
    "/api/buckets/bkt-1/objects/a.txt",
    "/api/buckets/bkt-1/objects/b.txt",
    "/api/buckets/bkt-1/objects/c.txt",
    "/api/buckets/bkt-1/objects/d.txt",
  ]);
  expect(row("a.txt").textContent).toContain("Done");
  expect(row("d.txt").textContent).toContain("Uploading");
});

test("cancel stops an upload and retry sends it again", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  fireEvent.click(within(row("d.txt")).getByRole("button", { name: "Cancel" }));
  expect(row("d.txt").textContent).toContain("Cancelled");
  expect(FakeRequest.sent).toHaveLength(3);
  fireEvent.click(within(row("a.txt")).getByRole("button", { name: "Cancel" }));
  expect(FakeRequest.sent[0]?.aborted).toBe(true);
  expect(row("a.txt").textContent).toContain("Cancelled");
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(row("a.txt").textContent).toContain("Cancelled");
  expect(row("a.txt").textContent).not.toContain("Done");
  fireEvent.click(within(row("a.txt")).getByRole("button", { name: "Retry" }));
  expect(FakeRequest.sent[3]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(row("a.txt").textContent).toContain("Uploading");
  await act(async () => {
    FakeRequest.sent[1]?.fail();
  });
  expect(row("b.txt").textContent).toContain("Failed");
  fireEvent.click(within(row("b.txt")).getByRole("button", { name: "Retry" }));
  expect(FakeRequest.sent[4]?.url).toBe("/api/buckets/bkt-1/objects/b.txt");
  expect(row("b.txt").textContent).toContain("Uploading");
});

test("skip does not PUT", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["keep.txt"]} />);
  choose(["keep.txt"]);
  expect(FakeRequest.sent).toHaveLength(0);
  expect(row("keep.txt").textContent).toContain("Queued");
  expect(window.onbeforeunload).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.queryByText("keep.txt")).toBeNull();
  expect(FakeRequest.sent).toHaveLength(0);
  expect(window.onbeforeunload).toBeNull();
});

test("skip lets the other file with that name upload", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["same.txt", "same.txt"]);
  expect(FakeRequest.sent).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Skip" })[0]);
  expect(screen.getAllByText("same.txt")).toHaveLength(1);
  expect(FakeRequest.sent.map((request) => request.url)).toEqual([
    "/api/buckets/bkt-1/objects/same.txt",
  ]);
});

test("overwrite sends the file bytes for that key", () => {
  render(<UploadPanel bucketId="bkt 1" existingKeys={["pre/a b!.txt"]} />);
  const input = screen.getByLabelText("Choose files");
  const file = new File(["abc"], "pre/a b!.txt", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(FakeRequest.sent).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  const sent = FakeRequest.sent[0];
  expect(sent?.method).toBe("PUT");
  expect(sent?.url).toBe("/api/buckets/bkt%201/objects/pre/a%20b%21.txt");
  expect(sent?.withCredentials).toBe(true);
  expect(sent?.headers.get("x-csrf-token")).toBe("csrf-token");
  expect(sent?.headers.get("content-type")).toBe("text/plain");
  expect(sent?.body).toBe(file);
});

test("uses application/octet-stream when the file has no type", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["raw.bin"]} />);
  const input = screen.getByLabelText("Choose files");
  const file = new File(["xyz"], "raw.bin", { type: "" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  expect(FakeRequest.sent[0]?.headers.get("content-type")).toBe("application/octet-stream");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("overwrite sends one copy and overwrite all sends the rest", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["same.txt", "same.txt"]);
  fireEvent.click(screen.getAllByRole("button", { name: "Overwrite" })[0]);
  expect(FakeRequest.sent).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Skip" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Overwrite all" }));
  expect(FakeRequest.sent).toHaveLength(2);
  expect(FakeRequest.sent[1]?.url).toBe("/api/buckets/bkt-1/objects/same.txt");
  expect(screen.queryByRole("button", { name: "Overwrite" })).toBeNull();
});

test("hides the percentage when the length is unknown", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
    choose(["a.txt"]);
    act(() => {
      vi.setSystemTime(new Date(2_000));
      FakeRequest.sent[0]?.emitProgress(1, 0, false);
    });
    expect(row("a.txt").textContent).toContain("Uploading");
    expect(row("a.txt").textContent).not.toContain("%");
    expect(row("a.txt").textContent).not.toContain("B/s");
  } finally {
    vi.useRealTimers();
  }
});

test("shows the percent and the byte rate after loaded progress", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
    choose(["a.txt"]);
    act(() => {
      FakeRequest.sent[0]?.emitProgress(12, 100);
    });
    expect(row("a.txt").textContent).toContain("12%");
    expect(row("a.txt").textContent).not.toContain("B/s");
    act(() => {
      vi.setSystemTime(new Date(2_000));
      FakeRequest.sent[0]?.emitProgress(12, 100);
    });
    expect(row("a.txt").textContent).toContain("12%");
    expect(row("a.txt").textContent).toContain("12 B/s");
  } finally {
    vi.useRealTimers();
  }
});

test("clear finished removes done, failed, and cancelled rows", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["done.txt"]);
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(row("done.txt").textContent).toContain("Done");
  expect(window.onbeforeunload).toBeNull();
  choose(["bad.txt"]);
  await act(async () => {
    FakeRequest.sent[1]?.fail();
  });
  expect(row("bad.txt").textContent).toContain("Failed");
  choose(["stop.txt"]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(row("stop.txt").textContent).toContain("Cancelled");
  choose(["wait.txt"]);
  expect(row("wait.txt").textContent).toContain("Uploading");
  fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
  expect(screen.queryByText("done.txt")).toBeNull();
  expect(screen.queryByText("bad.txt")).toBeNull();
  expect(screen.queryByText("stop.txt")).toBeNull();
  expect(row("wait.txt").textContent).toContain("Uploading");
  expect(row("wait.txt").textContent).not.toContain("Cancelled");
});

test("refetches bucket objects after a successful upload", async () => {
  const client = render(<UploadPanel bucketId="bkt-9" existingKeys={[]} />);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  choose(["done.txt"]);
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(row("done.txt").textContent).toContain("Done");
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bucket-objects", "bkt-9"] });
});

test("does not refetch bucket objects after a failed upload", async () => {
  const client = render(<UploadPanel bucketId="bkt-9" existingKeys={[]} />);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  choose(["bad.txt"]);
  await act(async () => {
    FakeRequest.sent[0]?.fail();
  });
  expect(row("bad.txt").textContent).toContain("Failed");
  expect(invalidate).not.toHaveBeenCalled();
});

function withRelativePath(name: string, relativePath: string) {
  const file = new File(["body"], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

test("uploads a chosen folder file at its relative path", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("docs/a.txt").textContent).toContain("Uploading");
});

test("asks before uploading a folder path that already exists", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["docs/a.txt"]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  expect(FakeRequest.sent).toHaveLength(0);
  expect(row("docs/a.txt").textContent).toContain("Queued");
  fireEvent.click(within(row("docs/a.txt")).getByRole("button", { name: "Overwrite" }));
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("uploads a folder file at its name when the relative path is empty", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("uploads a chosen file at its name when the relative path is empty", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("a.txt").textContent).toContain("Uploading");
});

test("keeps directory selection on the folder input only", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const files = screen.getByLabelText("Choose files");
  const folder = screen.getByLabelText("Choose folder");
  expect(files.hasAttribute("webkitdirectory")).toBe(false);
  expect(files.hasAttribute("multiple")).toBe(true);
  expect(folder.hasAttribute("webkitdirectory")).toBe(true);
  expect(folder.hasAttribute("multiple")).toBe(true);
  expect(files.classList.contains("w-full")).toBe(true);
  expect(files.classList.contains("min-w-0")).toBe(true);
  expect(files.classList.contains("max-w-full")).toBe(true);
  expect(folder.classList.contains("w-full")).toBe(true);
  expect(folder.classList.contains("min-w-0")).toBe(true);
  expect(folder.classList.contains("max-w-full")).toBe(true);
});

test("a dropped file keeps its file name when a relative path is set", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: { files: [file] },
  });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("accepts a dropped file", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["z"], "drop.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: { files: [file] },
  });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/drop.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("drop.txt").textContent).toContain("Uploading");
});

type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (done: (file: File) => void) => void;
  createReader?: () => { readEntries: (done: (entries: DropEntry[]) => void) => void };
};

function pagedReader(pages: DropEntry[][]) {
  let index = 0;
  return {
    readEntries(done: (entries: DropEntry[]) => void) {
      const page = pages[index] ?? [];
      index += 1;
      done(page);
    },
  };
}

function dropEntries(entries: DropEntry[], files: File[] = []) {
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: {
      files,
      items: entries.map((entry) => ({
        kind: "file",
        webkitGetAsEntry: () => entry,
      })),
    },
  });
}

test("a dropped file item keeps its file name", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["z"], "plain.txt", { type: "text/plain" });
  dropEntries(
    [
      {
        isFile: true,
        isDirectory: false,
        name: "nested/plain.txt",
        file(done) {
          done(new File(["other"], "nested.txt", { type: "text/plain" }));
        },
      },
    ],
    [file],
  );
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/plain.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("a drop without webkitGetAsEntry keeps the file name", () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["z"], "drop.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: {
      files: [file],
      items: [{ kind: "file" }],
    },
  });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/drop.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("uploads a dropped directory under its relative path", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["body"], "a.txt", { type: "text/plain" });
  const decoy = new File(["no"], "decoy.txt", { type: "text/plain" });
  const fileEntry: DropEntry = {
    isFile: true,
    isDirectory: false,
    name: "a.txt",
    file(done) {
      done(file);
    },
  };
  dropEntries(
    [
      {
        isFile: false,
        isDirectory: true,
        name: "docs",
        createReader: () => pagedReader([[fileEntry], []]),
      },
    ],
    [decoy],
  );
  await waitFor(() => {
    expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/a.txt");
  });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("docs/a.txt").textContent).toContain("Uploading");
});

test("uploads a nested dropped directory under its relative path", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["body"], "a.txt", { type: "text/plain" });
  const fileEntry: DropEntry = {
    isFile: true,
    isDirectory: false,
    name: "a.txt",
    file(done) {
      done(file);
    },
  };
  const empty: DropEntry = {
    isFile: false,
    isDirectory: true,
    name: "empty",
    createReader: () => pagedReader([[]]),
  };
  const sub: DropEntry = {
    isFile: false,
    isDirectory: true,
    name: "sub",
    createReader: () => pagedReader([[empty], [fileEntry], []]),
  };
  dropEntries([
    {
      isFile: false,
      isDirectory: true,
      name: "docs",
      createReader: () => pagedReader([[sub], []]),
    },
  ]);
  await waitFor(() => {
    expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/sub/a.txt");
  });
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("preserves active uploads on stay and cancels queued work on accepted navigation", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  expect(releaseHash("#departed")).toBe(false);
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unfinished uploads will be cancelled and unsaved changes will be lost.");
  expect(FakeRequest.sent.every((request) => !request.aborted)).toBe(true);
  expect(within(row("a.txt")).getByRole("button", { name: "Cancel" })).toBeTruthy();
  confirm.mockReturnValue(true);
  act(() => { expect(releaseHash("#departed")).toBe(true); });
  expect(FakeRequest.sent.every((request) => request.aborted)).toBe(true);
  await act(async () => { FakeRequest.sent[0]?.succeed(); });
  expect(FakeRequest.sent).toHaveLength(3);
  expect(row("d.txt").textContent).toContain("Cancelled");
});
test("rejects browser hash departure before page listeners", () => {
  window.history.replaceState(null, "", "/#objects");
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt"]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const arrival = vi.fn();
  window.addEventListener("hashchange", arrival);
  act(() => {
    window.history.replaceState(null, "", "/#keys");
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: "http://localhost/#objects" }));
  });
  expect(confirm).toHaveBeenCalledOnce();
  expect(arrival).not.toHaveBeenCalled();
  expect(window.location.hash).toBe("#objects");
  expect(FakeRequest.sent[0]?.aborted).toBe(false);
  window.removeEventListener("hashchange", arrival);
  window.history.replaceState(null, "", "/");
});
test("unmount aborts requests without starting queued files", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  cleanup();
  expect(FakeRequest.sent.every((request) => request.aborted)).toBe(true);
  await act(async () => { FakeRequest.sent[0]?.succeed(); });
  expect(FakeRequest.sent).toHaveLength(3);
});

test("successful upload refreshes rendered search results while collapsed jobs remain mounted", async () => {
  let searches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/search?")) {
      searches += 1;
      return new Response(JSON.stringify({ matches: searches > 1 ? [{ key: "new.txt", size: 1, etag: "e", lastModified: "2026-10-11T00:00:00Z" }] : [], truncated: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ prefix: "", entries: [], next: null }), { status: 200 });
  }));
  render(<Objects bucketId="bkt-1" onBack={() => {}} canWrite canTransfer={false} />);
  await screen.findByText("There are no objects. Upload the first object.");
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("There are no objects.");
  const disclosure = screen.getByText("Upload", { selector: "summary" }).closest("details");
  if (!disclosure) throw new Error("missing upload disclosure");
  expect(disclosure.open).toBe(false);
  fireEvent.click(screen.getByText("Upload", { selector: "summary" }));
  choose(["new.txt"]);
  const summary = disclosure.querySelector("summary");
  if (!summary) throw new Error("missing upload summary");
  fireEvent.click(summary);
  expect(disclosure.open).toBe(false);
  expect(summary.textContent).toContain("Uploading · 1");
  expect(FakeRequest.sent[0]?.aborted).toBe(false);
  await act(async () => { FakeRequest.sent[0]?.succeed(); });
  expect(await screen.findByRole("button", { name: "new.txt" })).toBeTruthy();
  expect(searches).toBe(2);
});

test("accepted browser departure aborts uploads and cannot start queued work", async () => {
  window.history.replaceState(null, "", "/#objects");
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  act(() => {
    window.history.replaceState(null, "", "/#accepted-departure");
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: "http://localhost/#objects" }));
  });
  expect(FakeRequest.sent.every((request) => request.aborted)).toBe(true);
  await act(async () => { FakeRequest.sent[0]?.succeed(); });
  expect(FakeRequest.sent).toHaveLength(3);
  window.history.replaceState(null, "", "/");
});
test("form-only navigation keeps the original unsaved-changes prompt", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  setFormDirty("test-form", true);
  try {
    expect(releaseHash("#form-departure")).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  } finally { setFormDirty("test-form", false); }
});

test("departure cancels a dropped directory still being read before any upload starts", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  let deliver: ((entries: DropEntry[]) => void) | undefined;
  dropEntries([{ isFile: false, isDirectory: true, name: "docs", createReader: () => ({ readEntries(done) { deliver = done; } }) }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  expect(releaseHash("#directory-departure")).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  act(() => { expect(releaseHash("#directory-departure")).toBe(true); });
  await act(async () => {
    deliver?.([{ isFile: true, isDirectory: false, name: "late.txt", file(done) { done(new File(["late"], "late.txt")); } }]);
    await Promise.resolve();
    deliver?.([]);
  });
  expect(FakeRequest.sent).toHaveLength(0);
});

test("staying during prefix navigation retains page, selection and active upload; leaving cancels", async () => {
  window.history.replaceState(null, "", `/${hashForObjects("bkt-1", "")}`);
  const entry = (key: string) => ({ kind: "object", key, size: 1, etag: "e", lastModified: "2026-10-11T00:00:00Z" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    const prefix = url.searchParams.get("prefix") ?? "";
    const entries = prefix === "folder/" ? [entry("folder/destination.txt")] : url.searchParams.has("next") ? [entry("second.txt"), { kind: "prefix", prefix: "folder/" }] : [entry("first.txt")];
    return new Response(JSON.stringify({ prefix, entries, next: prefix === "" && !url.searchParams.has("next") ? "page-2" : null }), { status: 200 });
  }));
  render(<Objects bucketId="bkt-1" onBack={() => {}} canWrite canTransfer={false} />);
  await screen.findByRole("button", { name: "first.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("button", { name: "second.txt" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select second.txt" }));
  fireEvent.click(screen.getByText("Upload", { selector: "summary" }));
  choose(["active.txt"]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "folder/" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Select second.txt" }) as HTMLInputElement).checked).toBe(true);
  expect(window.location.hash).toBe(hashForObjects("bkt-1", ""));
  expect(FakeRequest.sent[0]?.aborted).toBe(false);
  expect(within(row("active.txt")).getByRole("button", { name: "Cancel" })).toBeTruthy();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "folder/" }));
  await screen.findByRole("button", { name: "folder/destination.txt" });
  expect(FakeRequest.sent[0]?.aborted).toBe(true);
  expect(row("active.txt").textContent).toContain("Cancelled");
  expect(screen.getByText("Page 1")).toBeTruthy();
});

test("staying during breadcrumb navigation retains search and selection during a pending directory read", async () => {
  window.history.replaceState(null, "", `/${hashForObjects("bkt-1", "folder/")}`);
  const match = { key: "search.txt", size: 1, etag: "e", lastModified: "2026-10-11T00:00:00Z" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/search?") ? { matches: [match], truncated: false } : { prefix: "", entries: [], next: null }), { status: 200 })));
  render(<Objects bucketId="bkt-1" onBack={() => {}} canWrite canTransfer={false} />);
  await screen.findByText("There are no objects. Upload the first object.");
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "search" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select search.txt" }));
  fireEvent.click(screen.getByText("Upload", { selector: "summary" }));
  let deliver: ((entries: DropEntry[]) => void) | undefined;
  dropEntries([{ isFile: false, isDirectory: true, name: "docs", createReader: () => ({ readEntries(done) { deliver = done; } }) }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  // Leaving the current prefix must guard before clearing local search state.
  fireEvent.click(screen.getByRole("button", { name: "bkt-1" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("search");
  expect((screen.getByRole("checkbox", { name: "Select search.txt" }) as HTMLInputElement).checked).toBe(true);
  expect(window.location.search).toContain("objects=search");
  expect(screen.getByText("Queued · 1")).toBeTruthy();
  await act(async () => { deliver?.([]); });
});
