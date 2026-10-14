import { Theme } from "@radix-ui/themes";
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
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  FakeRequest.sent = [];
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "not_found", message: "Object not found" }), { status: 404 })));
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
  renderTree(<Theme><QueryClientProvider client={client}>{ui}</QueryClientProvider></Theme>);
  return client;
}

test("keeps a fourth file queued until an upload slot frees", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  await act(async () => {});
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
  await act(async () => {});
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
  await act(async () => {});
  expect(FakeRequest.sent[3]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(row("a.txt").textContent).toContain("Uploading");
  await act(async () => {
    FakeRequest.sent[1]?.fail();
  });
  expect(row("b.txt").textContent).toContain("Failed");
  fireEvent.click(within(row("b.txt")).getByRole("button", { name: "Retry" }));
  await act(async () => {});
  expect(FakeRequest.sent[4]?.url).toBe("/api/buckets/bkt-1/objects/b.txt");
  expect(row("b.txt").textContent).toContain("Uploading");
});

test("skip does not PUT", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["keep.txt"]} />);
  choose(["keep.txt"]);
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(0);
  expect(row("keep.txt").textContent).toContain("Queued");
  expect(window.onbeforeunload).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.queryByText("keep.txt")).toBeNull();
  expect(FakeRequest.sent).toHaveLength(0);
  expect(window.onbeforeunload).toBeNull();
});

test("skip lets the other file with that name upload", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["same.txt", "same.txt"]);
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Skip" })[0]);
  expect(screen.getAllByText("same.txt")).toHaveLength(1);
  await act(async () => {});
  expect(FakeRequest.sent.map((request) => request.url)).toEqual([
    "/api/buckets/bkt-1/objects/same.txt",
  ]);
});

test("overwrite sends the file bytes for that key", async () => {
  render(<UploadPanel bucketId="bkt 1" existingKeys={["pre/a b!.txt"]} />);
  const input = screen.getByLabelText("Choose files");
  const file = new File(["abc"], "pre/a b!.txt", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
  await act(async () => {});
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

test("uses application/octet-stream when the file has no type", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["raw.bin"]} />);
  const input = screen.getByLabelText("Choose files");
  const file = new File(["xyz"], "raw.bin", { type: "" });
  fireEvent.change(input, { target: { files: [file] } });
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
  expect(FakeRequest.sent[0]?.headers.get("content-type")).toBe("application/octet-stream");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("overwrite sends one copy and overwrite all sends the rest", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["same.txt", "same.txt"]);
  await act(async () => {});
  fireEvent.click(screen.getAllByRole("button", { name: "Overwrite" })[0]);
  expect(FakeRequest.sent).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Skip" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Overwrite all" }));
  expect(FakeRequest.sent).toHaveLength(2);
  expect(FakeRequest.sent[1]?.url).toBe("/api/buckets/bkt-1/objects/same.txt");
  expect(screen.queryByRole("button", { name: "Overwrite" })).toBeNull();
});

test("hides the percentage when the length is unknown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
    choose(["a.txt"]);
  await act(async () => {});
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

test("shows the percent and the byte rate after loaded progress", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000));
  try {
    render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
    choose(["a.txt"]);
  await act(async () => {});
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
  await act(async () => {});
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(row("done.txt").textContent).toContain("Done");
  expect(window.onbeforeunload).toBeNull();
  choose(["bad.txt"]);
  await act(async () => {});
  await act(async () => {
    FakeRequest.sent[1]?.fail();
  });
  expect(row("bad.txt").textContent).toContain("Failed");
  choose(["stop.txt"]);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(row("stop.txt").textContent).toContain("Cancelled");
  choose(["wait.txt"]);
  await act(async () => {});
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
  await act(async () => {});
  await act(async () => {
    FakeRequest.sent[0]?.succeed();
  });
  expect(row("done.txt").textContent).toContain("Done");
  expect(invalidate).toHaveBeenCalledTimes(5);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bucket-objects", "bkt-9"] });
});

test("does not refetch bucket objects after a failed upload", async () => {
  const client = render(<UploadPanel bucketId="bkt-9" existingKeys={[]} />);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  choose(["bad.txt"]);
  await act(async () => {});
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

test("uploads a chosen folder file at its relative path", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("docs/a.txt").textContent).toContain("Uploading");
});

test("asks before uploading a folder path that already exists", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={["docs/a.txt"]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(0);
  expect(row("docs/a.txt").textContent).toContain("Queued");
  fireEvent.click(within(row("docs/a.txt")).getByRole("button", { name: "Overwrite" }));
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/docs/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("uploads a folder file at its name when the relative path is empty", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "");
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files: [file] } });
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("uploads a chosen file at its name when the relative path is empty", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
  expect(row("a.txt").textContent).toContain("Uploading");
});

test("keeps directory selection on the folder input only", async () => {
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

test("a dropped file keeps its file name when a relative path is set", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = withRelativePath("a.txt", "docs/a.txt");
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: { files: [file] },
  });
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/a.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("accepts a dropped file", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["z"], "drop.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: { files: [file] },
  });
  await act(async () => {});
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

test("a dropped file item keeps its file name", async () => {
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
  await act(async () => {});
  expect(FakeRequest.sent).toHaveLength(1);
  expect(FakeRequest.sent[0]?.url).toBe("/api/buckets/bkt-1/objects/plain.txt");
  expect(FakeRequest.sent[0]?.body).toBe(file);
});

test("a drop without webkitGetAsEntry keeps the file name", async () => {
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  const file = new File(["z"], "drop.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("region", { name: "Upload" }), {
    dataTransfer: {
      files: [file],
      items: [{ kind: "file" }],
    },
  });
  await act(async () => {});
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
  await act(async () => {});
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
test("rejects browser hash departure before page listeners", async () => {
  window.history.replaceState(null, "", "/#objects");
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt"]);
  await act(async () => {});
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
  await act(async () => {});
  cleanup();
  expect(FakeRequest.sent.every((request) => request.aborted)).toBe(true);
  await act(async () => { FakeRequest.sent[0]?.succeed(); });
  expect(FakeRequest.sent).toHaveLength(3);
});

test("successful upload refreshes rendered search results while collapsed jobs remain mounted", async () => {
  let searches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/objects/")) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
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
  const disclosure = screen.getByText("Close upload", { selector: "summary" }).closest("details");
  if (!disclosure) throw new Error("missing upload disclosure");
  expect(disclosure.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  choose(["new.txt"]);
  await act(async () => {});
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
  await act(async () => {});
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
test("form-only navigation keeps the original unsaved-changes prompt", async () => {
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
    if (url.pathname.includes("/objects/")) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    const prefix = url.searchParams.get("prefix") ?? "";
    const entries = prefix === "folder/" ? [entry("folder/destination.txt")] : url.searchParams.has("next") ? [entry("second.txt"), { kind: "prefix", prefix: "folder/" }] : [entry("first.txt")];
    return new Response(JSON.stringify({ prefix, entries, next: prefix === "" && !url.searchParams.has("next") ? "page-2" : null }), { status: 200 });
  }));
  render(<Objects bucketId="bkt-1" onBack={() => {}} canWrite canTransfer={false} />);
  await screen.findByRole("button", { name: "first.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("button", { name: "second.txt" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select second.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  choose(["active.txt"]);
  await act(async () => {});
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "folder/" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Select second.txt" }).getAttribute("aria-checked")).toBe("true");
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
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  let deliver: ((entries: DropEntry[]) => void) | undefined;
  dropEntries([{ isFile: false, isDirectory: true, name: "docs", createReader: () => ({ readEntries(done) { deliver = done; } }) }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  // Leaving the current prefix must guard before clearing local search state.
  fireEvent.click(screen.getByRole("button", { name: "Root (bkt-1)" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("search");
  expect(screen.getByRole("checkbox", { name: "Select search.txt" }).getAttribute("aria-checked")).toBe("true");
  expect(window.location.search).toContain("objects=search");
  expect(screen.getByText("Queued · 1")).toBeTruthy();
  await act(async () => { deliver?.([]); });
});


test("checks an unlisted destination and requires overwrite before sending bytes", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ key: "z?.txt" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  render(<UploadPanel bucketId="bkt 1" existingKeys={[]} />);
  choose(["z?.txt"]);
  await act(async () => {});
  await waitFor(() => expect(within(row("z?.txt")).getByRole("button", { name: "Overwrite" })).toBeTruthy());
  expect(FakeRequest.sent).toHaveLength(0);
  expect(fetch).toHaveBeenCalledWith("/api/buckets/bkt%201/objects/z%3F.txt", expect.objectContaining({ method: "GET", credentials: "include", signal: expect.any(AbortSignal) }));
  fireEvent.click(within(row("z?.txt")).getByRole("button", { name: "Overwrite" }));
  expect(FakeRequest.sent).toHaveLength(1);
});

test.each([401, 403, 500])("blocks upload after metadata status %s and retries the check", async (status) => {
  let retry = false;
  const fetch = vi.fn(async () => new Response(JSON.stringify(retry ? { code: "not_found", message: "Object missing" } : { code: "unavailable", message: "Cannot check destination" }), { status: retry ? 404 : status }));
  vi.stubGlobal("fetch", fetch);
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt"]);
  await act(async () => {});
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Cannot check destination"));
  expect(FakeRequest.sent).toHaveLength(0);
  retry = true;
  fireEvent.click(within(row("a.txt")).getByRole("button", { name: "Retry" }));
  await act(async () => {});
  await waitFor(() => expect(FakeRequest.sent).toHaveLength(1));
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("bounds pending destination checks and ignores a cancelled check result", async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
  vi.stubGlobal("fetch", fetch);
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt", "b.txt", "c.txt", "d.txt"]);
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(FakeRequest.sent).toHaveLength(0);
  fireEvent.click(within(row("a.txt")).getByRole("button", { name: "Cancel" }));
  expect(fetch).toHaveBeenCalledTimes(4);
  await act(async () => pending[0]?.(new Response(JSON.stringify({ code: "not_found" }), { status: 404 })));
  expect(FakeRequest.sent).toHaveLength(0);
  expect(row("a.txt").textContent).toContain("Cancelled");
});

test("successful overwrite invalidates only that object's metadata, text and inspection", async () => {
  const client = render(<UploadPanel bucketId="bkt-1" existingKeys={["a.txt"]} />);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  choose(["a.txt"]);
  await act(async () => {});
  fireEvent.click(within(row("a.txt")).getByRole("button", { name: "Overwrite" }));
  await act(async () => FakeRequest.sent[0]?.succeed());
  for (const family of ["bucket-object", "bucket-object-text", "bucket-object-inspect"]) {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [family, "bkt-1", "a.txt"], exact: true });
  }
});


test("network failure blocks upload instead of authorizing absence", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt"]);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Network unavailable");
  expect(FakeRequest.sent).toHaveLength(0);
  expect(within(row("a.txt")).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test.each(["unmount", "bucket change"])("%s aborts pending checks and ignores their late result", async (departure) => {
  let deliver: (response: Response) => void = () => {};
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { deliver = resolve; });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (bucketId: string) => <QueryClientProvider client={client}><UploadPanel bucketId={bucketId} existingKeys={[]} /></QueryClientProvider>;
  const mounted = renderTree(tree("a"));
  choose(["a.txt"]);
  if (departure === "unmount") mounted.unmount();
  else mounted.rerender(tree("b"));
  expect(signal?.aborted).toBe(true);
  await act(async () => deliver(new Response(JSON.stringify({ code: "not_found" }), { status: 404 })));
  expect(FakeRequest.sent).toHaveLength(0);
  expect(screen.queryByText("a.txt")).toBeNull();
});
