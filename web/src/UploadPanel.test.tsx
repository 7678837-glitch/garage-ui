import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as renderTree, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UploadPanel } from "./UploadPanel";

type Progress = { lengthComputable: boolean; loaded: number; total: number };

class FakeRequest {
  static sent: FakeRequest[] = [];

  method = "";
  url = "";
  withCredentials = false;
  aborted = false;
  status = 0;
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
  render(<UploadPanel bucketId="bkt-1" existingKeys={[]} />);
  choose(["a.txt"]);
  act(() => {
    FakeRequest.sent[0]?.emitProgress(1, 0, false);
  });
  expect(row("a.txt").textContent).toContain("Uploading");
  expect(row("a.txt").textContent).not.toContain("%");
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
  expect(invalidate).toHaveBeenCalledTimes(1);
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
