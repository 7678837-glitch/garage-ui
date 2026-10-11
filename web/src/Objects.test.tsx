import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";
import { Objects } from "./Objects";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

function renderObjects(
  bucketId = "bkt-1",
  access: { canWrite: boolean; canTransfer: boolean } = { canWrite: true, canTransfer: true },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Objects
        bucketId={bucketId}
        onBack={onBack}
        canWrite={access.canWrite}
        canTransfer={access.canTransfer}
      />
    </QueryClientProvider>,
  );
  return onBack;
}

function renderBuckets() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Buckets canWrite={true} canTransfer={true} />
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const photo = {
  kind: "object",
  key: "photos/a.txt",
  size: 12,
  etag: "abc",
  lastModified: "2026-10-11T00:00:00Z",
};

function objectRow(key: string, size: number, lastModified: string) {
  return { kind: "object", key, size, etag: "abc", lastModified };
}

function page(entries: unknown[], next: string | null = null, prefix = "") {
  return { prefix, entries, next };
}

function listed(key: string) {
  return page([objectRow(key, 1, "2026-10-11T00:00:00Z")]);
}

test("shows the Upload region after opening a bucket", async () => {
  class QuietRequest {
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {}
  }
  vi.stubGlobal("XMLHttpRequest", QuietRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/buckets") {
        return json({ items: [{ id: "bkt-1", globalAliases: ["east"] }], hasMore: false });
      }
      if (url.pathname === "/api/buckets/bkt-1/objects") {
        return json(page([{ kind: "prefix", prefix: "photos/" }, photo]));
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderBuckets();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Objects for bkt-1" }));
  const objectButton = await screen.findByRole("button", { name: "photos/a.txt" });
  const upload = screen.getByRole("region", { name: "Upload" });
  const prefixButton = screen.getByRole("button", { name: "photos/" });
  expect(upload.textContent).toContain("Drop files here.");
  expect(upload.contains(objectButton)).toBe(false);
  expect(upload.contains(prefixButton)).toBe(false);
  expect(upload.compareDocumentPosition(objectButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const input = within(upload).getByLabelText("Choose files");
  fireEvent.change(input, {
    target: { files: [new File(["a"], "photos/a.txt", { type: "text/plain" })] },
  });
  const objectFile = within(upload).getByText("photos/a.txt").closest("li");
  if (!(objectFile instanceof HTMLElement)) {
    throw new Error("missing upload row photos/a.txt");
  }
  expect(objectFile.textContent).toContain("Queued");
  expect(within(objectFile).getByRole("button", { name: "Overwrite" }).textContent).toBe(
    "Overwrite",
  );
  expect(objectFile.textContent).not.toContain("Uploading");
  fireEvent.change(input, {
    target: { files: [new File(["p"], "photos/", { type: "text/plain" })] },
  });
  const prefixFile = within(upload).getByText("photos/").closest("li");
  if (!(prefixFile instanceof HTMLElement)) {
    throw new Error("missing upload row photos/");
  }
  expect(prefixFile.textContent).toContain("Uploading");
  expect(within(prefixFile).queryByRole("button", { name: "Overwrite" })).toBeNull();
});

test("opens a bucket, shows the chosen object's type, and returns to the table", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/buckets") {
        return json({ items: [{ id: "bkt-1", globalAliases: ["east"] }], hasMore: false });
      }
      if (url.pathname === "/api/buckets/bkt-1/objects") {
        expect(url.searchParams.get("prefix")).toBe("");
        expect(url.searchParams.get("limit")).toBe("100");
        return json(
          page([{ kind: "prefix", prefix: "photos/" }, photo]),
        );
      }
      if (url.pathname === "/api/buckets/bkt-1/objects/photos/a.txt") {
        return json({
          key: "photos/a.txt",
          size: 12,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderBuckets();
  fireEvent.click(await screen.findByRole("button", { name: "Objects for bkt-1" }));
  expect(await screen.findByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/a.txt" })).toBeTruthy();
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("2026-10-11T00:00:00Z")).toBeTruthy();
  expect(screen.queryByText("east")).toBeNull();
  expect(screen.queryByRole("button", { name: "Objects for bkt-1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "photos/a.txt" }));
  expect(await screen.findByText("text/plain")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to buckets" }));
  expect(await screen.findByText("east")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Objects for bkt-1" })).toBeTruthy();
  expect(screen.queryByText("text/plain")).toBeNull();
  expect(screen.queryByRole("button", { name: "photos/a.txt" })).toBeNull();
});

test("moves into a prefix and a breadcrumb segment sets that prefix", async () => {
  const prefixes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      const prefix = url.searchParams.get("prefix") ?? "";
      prefixes.push(prefix);
      if (prefix === "") {
        return json(page([{ kind: "prefix", prefix: "photos/2024/" }]));
      }
      if (prefix === "photos/2024/") {
        return json(page([objectRow("photos/2024/a.txt", 4, "2026-10-11T00:00:00Z")], null, prefix));
      }
      if (prefix === "photos/") {
        return json(page([objectRow("photos/b.txt", 5, "2026-10-11T00:00:00Z")], null, prefix));
      }
      return json({ message: "unexpected prefix" }, 500);
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "photos/2024/" }));
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/2024/");
  expect(await screen.findByRole("button", { name: "photos/2024/a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "2024" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "photos" }));
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/");
  expect(await screen.findByRole("button", { name: "photos/b.txt" })).toBeTruthy();
  expect(prefixes).toContain("photos/2024/");
  expect(prefixes).toContain("photos/");
});

test("opens the prefix from the address and follows hashchange", async () => {
  window.location.hash = "#buckets/bkt-1/photos/2024%20q/";
  const prefixes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const prefix = new URL(String(input), "http://ui.local").searchParams.get("prefix") ?? "";
      prefixes.push(prefix);
      return json(page([objectRow(`${prefix}a.txt`, 1, "2026-10-11T00:00:00Z")], null, prefix));
    }),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "photos/2024 q/a.txt" })).toBeTruthy();
  expect(prefixes[0]).toBe("photos/2024 q/");
  window.location.hash = "#buckets/bkt-1/photos/";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(await screen.findByRole("button", { name: "photos/a.txt" })).toBeTruthy();
  expect(prefixes).toContain("photos/");
});

test("wraps a 64-character bucket id and object key", async () => {
  const bucketId = "b".repeat(64);
  const key = "k".repeat(64);
  window.location.hash = `#buckets/${bucketId}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(page([objectRow(key, 1, "2026-10-11T00:00:00Z")]))),
  );
  renderObjects(bucketId);
  const idButton = await screen.findByRole("button", { name: bucketId });
  const keyButton = await screen.findByRole("button", { name: key });
  expect(idButton.className).toContain("break-all");
  expect(idButton.className).toContain("min-w-0");
  expect(idButton.className).toContain("max-w-full");
  expect(keyButton.className).toContain("break-all");
  expect(keyButton.className).toContain("min-w-0");
  expect(keyButton.className).toContain("max-w-full");
});

test("requests the next token and shows that page", async () => {
  const tokens: Array<string | null> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("prefix")).toBe("");
      tokens.push(url.searchParams.get("next"));
      if (url.searchParams.get("next") === "page-2") {
        return json(page([objectRow("b.txt", 2, "2026-10-12T00:00:00Z")]));
      }
      return json(page([objectRow("a.txt", 9, "2026-10-11T00:00:00Z")], "page-2"));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("button", { name: "b.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "a.txt" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  expect(tokens).toEqual([null, "page-2"]);
});

test("does not search below 2 characters", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes("/search")) {
        return json({
          matches: [objectRow("secret-match", 1, "2026-10-11T00:00:00Z")],
          truncated: false,
          reason: null,
        });
      }
      return json(listed("listed.txt"));
    }),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "listed.txt" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "listed.txt" })).toBeTruthy();
  });
  expect(screen.queryByRole("button", { name: "secret-match" })).toBeNull();
  expect(calls.some((call) => call.includes("/search"))).toBe(false);
});

test("shows a truncated search reason", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname.endsWith("/search")) {
        expect(url.searchParams.get("q")).toBe("ph");
        expect(url.searchParams.get("prefix")).toBe("");
        return json({
          matches: [photo],
          truncated: true,
          reason: "result_limit",
        });
      }
      return json(listed("listed.txt"));
    }),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "listed.txt" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "ph" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("result_limit")).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/a.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "listed.txt" })).toBeNull();
});

test("sorts the loaded rows by size or time and says only this page", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          { kind: "prefix", prefix: "folder/" },
          objectRow("c.txt", 5, "2026-10-13T00:00:00Z"),
          objectRow("b.txt", 20, "2026-10-11T00:00:00Z"),
          objectRow("a.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "c.txt" })).toBeTruthy();
  expect(screen.queryByText("Only this page")).toBeNull();
  expect(rowOrder()).toEqual(["folder/", "c.txt", "b.txt", "a.txt"]);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "size" } });
  expect(screen.getByText("Only this page")).toBeTruthy();
  expect(rowOrder()).toEqual(["folder/", "a.txt", "c.txt", "b.txt"]);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "time" } });
  expect(screen.getByText("Only this page")).toBeTruthy();
  expect(rowOrder()).toEqual(["folder/", "b.txt", "a.txt", "c.txt"]);
  fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "key" } });
  expect(screen.queryByText("Only this page")).toBeNull();
  expect(rowOrder()).toEqual(["folder/", "c.txt", "b.txt", "a.txt"]);
});

test("says there are no objects after the list loads", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  renderObjects();
  const section = screen.getByRole("region", { name: "Objects" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("Loading objects")).toBeTruthy();
  expect(screen.queryByText("There are no objects.")).toBeNull();
  release(json(page([])));
  expect(await screen.findByText("There are no objects.")).toBeTruthy();
  expect(screen.queryByText("Loading objects")).toBeNull();
  expect(screen.getByRole("region", { name: "Objects" }).getAttribute("aria-busy")).toBe("false");
});

test("shows the error message and loads again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return json({ code: "garage_unavailable", message: "Objects are not reachable" }, 502);
      }
      return json(listed("back.txt"));
    }),
  );
  renderObjects();
  expect(await screen.findByText("Objects are not reachable")).toBeTruthy();
  expect(screen.getByText("garage_unavailable")).toBeTruthy();
  expect(screen.getByText("garage_unavailable").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no objects.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "back.txt" })).toBeTruthy();
  expect(screen.queryByText("Objects are not reachable")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps the loaded page when the next token fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const next = new URL(String(input), "http://ui.local").searchParams.get("next");
      if (next === "page-2") {
        return json({ message: "page failed" }, 502);
      }
      return json(page([objectRow("photos/a.txt", 9, "2026-10-11T00:00:00Z")], "page-2"));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  expect(await screen.findByText("page failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("encodes each key segment when loading metadata", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = String(input);
      calls.push(raw);
      if (raw.includes("a%3Fb.txt")) {
        return json({
          key: "dir/a?b.txt",
          size: 1,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        });
      }
      return json(page([objectRow("dir/a?b.txt", 1, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "dir/a?b.txt" }));
  expect(await screen.findByText("text/plain")).toBeTruthy();
  const meta = calls.find((call) => call.includes("a%3Fb.txt"));
  expect(meta).toBe("/api/buckets/bkt-1/objects/dir/a%3Fb.txt");
});

function box(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

test("hides the copy bar until an object row is selected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(page([objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]))),
  );
  renderObjects();
  expect(await screen.findByRole("checkbox", { name: "Select a.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  expect(screen.queryByText("Copied")).toBeNull();
});

test("copies two selected object paths, one per line", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(box("Select a.txt").checked).toBe(true);
  expect(box("Select b.txt").checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  expect(await screen.findByText("Copied")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith("a.txt\nb.txt");
});

test("shift-click selects the inclusive range of object rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
          { kind: "prefix", prefix: "folder/" },
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
          objectRow("c.txt", 3, "2026-10-13T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select c.txt" }), { shiftKey: true });
  expect(box("Select a.txt").checked).toBe(true);
  expect(box("Select b.txt").checked).toBe(true);
  expect(box("Select c.txt").checked).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Select folder/" })).toBeNull();
});

test("select page checks object rows on this page and skips the prefix", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const next = new URL(String(input), "http://ui.local").searchParams.get("next");
      if (next === "page-2") {
        return json(
          page([
            { kind: "prefix", prefix: "folder/" },
            objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
            objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
          ]),
        );
      }
      return json(page([objectRow("other.txt", 9, "2026-10-10T00:00:00Z")], "page-2"));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select other.txt" }));
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Select folder/" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select page" }));
  expect(box("Select a.txt").checked).toBe(true);
  expect(box("Select b.txt").checked).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Select other.txt" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  expect(await screen.findByText("Copied")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith("a.txt\nb.txt");
});

test("clears the selection when the prefix changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const prefix = new URL(String(input), "http://ui.local").searchParams.get("prefix") ?? "";
      if (prefix === "photos/") {
        return json(page([objectRow("photos/b.txt", 2, "2026-10-12T00:00:00Z")], null, prefix));
      }
      return json(page([{ kind: "prefix", prefix: "photos/" }, objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "photos/" }));
  expect(await screen.findByRole("checkbox", { name: "Select photos/b.txt" })).toBeTruthy();
  expect(box("Select photos/b.txt").checked).toBe(false);
  expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/");
});

test("asks to select the paths when the page is not a secure context", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(page([objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]))),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  expect(await screen.findByText("Select the paths and copy them")).toBeTruthy();
  expect((screen.getByLabelText("Selected paths") as HTMLTextAreaElement).value).toBe("a.txt");
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByText("Copied")).toBeNull();
});

test("shows Delete when one or more objects are selected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects();
  expect(await screen.findByRole("checkbox", { name: "Select a.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("shows Preview and Download only for one selected object", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json(
        page([
          objectRow("dir/a?b.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects("b k");
  expect(await screen.findByRole("checkbox", { name: "Select dir/a?b.txt" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select dir/a?b.txt" }));
  const preview = screen.getByRole("link", { name: "Preview" });
  const download = screen.getByRole("link", { name: "Download" });
  expect(preview.getAttribute("href")).toBe("/api/buckets/b%20k/objects/dir/a%3Fb.txt?preview=1");
  expect(download.getAttribute("href")).toBe("/api/buckets/b%20k/objects/dir/a%3Fb.txt?download=1");
  expect(preview.getAttribute("target")).toBe("_blank");
  expect(download.getAttribute("target")).toBe("_blank");
  expect(preview.getAttribute("rel")).toBe("noopener");
  expect(download.getAttribute("rel")).toBe("noopener");
  expect(calls.some((call) => call.includes("preview=1") || call.includes("download=1"))).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("cancels an object delete without a request, then removes the row after 204", async () => {
  const calls: { url: string; method: string }[] = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(input), method });
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (deleted) {
        return json(page([objectRow("keep.txt", 2, "2026-10-12T00:00:00Z")]));
      }
      return json(
        page([
          objectRow("dir/a?b.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("keep.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects("b k");
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select dir/a?b.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Confirm dir/a?b.txt");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeTruthy();
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  expect(dialog.textContent).toContain("This permanently deletes dir/a?b.txt.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(screen.getByRole("button", { name: "dir/a?b.txt" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "dir/a?b.txt" })).toBeNull();
  });
  expect(screen.getByRole("button", { name: "keep.txt" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  expect(box("Select keep.txt").checked).toBe(false);
  const deletes = calls.filter((call) => call.method === "DELETE");
  expect(deletes).toEqual([
    { url: "/api/buckets/b%20k/objects/dir/a%3Fb.txt", method: "DELETE" },
  ]);
});

test("keeps the object and shows the error when delete is forbidden", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        expect(String(input)).toBe("/api/buckets/bkt-1/objects/a.txt");
        return json({ message: "Not allowed to delete this object" }, 403);
      }
      return json(page([objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(/Not allowed to delete this object/)).toBeTruthy();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("This permanently deletes a.txt.");
  expect(dialog.textContent).toContain("Not allowed to delete this object");
  expect(screen.getByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(box("Select a.txt").checked).toBe(true);
});

test("requires the selected count before one batch delete", async () => {
  const rows = [
    objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
    objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
  ];
  const calls: { url: string; method: string; body: string | null }[] = [];
  let posted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url: String(input),
        method,
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (method === "POST") {
        posted = true;
        return json({ deleted: ["a.txt", "b.txt"], failed: [] });
      }
      if (posted) {
        return json(
          page([
            objectRow("a.txt", 9, "2026-10-11T00:00:00Z"),
            objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
          ]),
        );
      }
      return json(page(rows));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select b.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Deletes 2 objects, 3 bytes.");
  expect(dialog.textContent).toContain("This permanently deletes 2 objects.");
  const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "3" } });
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(calls.some((call) => call.method !== "GET")).toBe(false);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "2" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("9")).toBeTruthy();
  });
  expect(box("Select a.txt").checked).toBe(false);
  expect(box("Select b.txt").checked).toBe(false);
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    {
      url: "/api/buckets/bkt-1/objects:delete",
      method: "POST",
      body: JSON.stringify({ keys: ["a.txt", "b.txt"] }),
    },
  ]);
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
});

test("keeps the batch dialog open when a key fails", async () => {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(input), method });
      if (method === "POST") {
        return json({
          deleted: ["a.txt"],
          failed: [{ key: "b.txt", message: "denied by policy" }],
        });
      }
      return json(
        page([
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(/b\.txt: denied by policy/)).toBeTruthy();
  const open = screen.getByRole("dialog");
  expect(open.textContent).toContain("This permanently deletes 2 objects.");
  expect(open.textContent).toContain("b.txt: denied by policy");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(box("Select a.txt").checked).toBe(true);
  expect(box("Select b.txt").checked).toBe(true);
});

test("shows Delete folder on a prefix row and not on an object row", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          { kind: "prefix", prefix: "photos/" },
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects();
  const prefixRow = (await screen.findByRole("button", { name: "photos/" })).closest("tr");
  const fileRow = screen.getByRole("button", { name: "a.txt" }).closest("tr");
  if (!(prefixRow instanceof HTMLElement) || !(fileRow instanceof HTMLElement)) {
    throw new Error("missing object list row");
  }
  expect(within(prefixRow).getByRole("button", { name: "Delete folder" })).toBeTruthy();
  expect(within(fileRow).queryByRole("button", { name: "Delete folder" })).toBeNull();
});

test("requires the typed prefix before recursive delete, then drops the row after 200", async () => {
  const prefix = "a?b/";
  const calls: { url: string; method: string }[] = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(input), method });
      if (method === "DELETE") {
        deleted = true;
        return json({ deleted: 2, errors: [] });
      }
      if (deleted) {
        return json(page([objectRow("keep.txt", 2, "2026-10-12T00:00:00Z")]));
      }
      return json(page([{ kind: "prefix", prefix }, objectRow("keep.txt", 2, "2026-10-12T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
  expect(window.location.hash).toBe("");
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Confirm a?b/");
  expect(dialog.textContent).toContain("This deletes every object under this prefix.");
  expect(dialog.textContent).toContain(
    "This permanently deletes every object whose key starts with a?b/.",
  );
  const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(screen.getByRole("button", { name: prefix })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
  const again = screen.getByRole("dialog");
  const againConfirm = within(again).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  fireEvent.change(within(again).getByRole("textbox"), { target: { value: "a?b" } });
  expect(againConfirm.disabled).toBe(true);
  fireEvent.click(againConfirm);
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.change(within(again).getByRole("textbox"), { target: { value: prefix } });
  expect(againConfirm.disabled).toBe(false);
  fireEvent.click(againConfirm);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: prefix })).toBeNull();
  });
  expect(screen.getByRole("button", { name: "keep.txt" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(calls.filter((call) => call.method === "DELETE")).toEqual([
    { url: "/api/buckets/bkt-1/objects/a%3Fb/?recursive=true", method: "DELETE" },
  ]);
});

test("keeps the prefix row and shows the error when folder delete is forbidden", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        expect(String(input)).toBe("/api/buckets/bkt-1/objects/photos/?recursive=true");
        return json({ message: "Not allowed to delete this prefix" }, 403);
      }
      return json(
        page([
          { kind: "prefix", prefix: "photos/" },
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
  const dialog = screen.getByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "photos/" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(await screen.findByText(/Not allowed to delete this prefix/)).toBeTruthy();
  const open = screen.getByRole("dialog");
  expect(open.textContent).toContain(
    "This permanently deletes every object whose key starts with photos/.",
  );
  expect(open.textContent).toContain("Not allowed to delete this prefix");
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete folder" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "a.txt" })).toBeTruthy();
});

test("hides upload, delete, preview, and download when the viewer cannot transfer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = String(input);
      if (raw.includes("/objects/a.txt")) {
        return json({
          key: "a.txt",
          size: 1,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        });
      }
      return json(
        page([
          { kind: "prefix", prefix: "photos/" },
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects("bkt-1", { canWrite: false, canTransfer: false });
  expect(await screen.findByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.getByLabelText("Search")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  expect(await screen.findByText("text/plain")).toBeTruthy();
});

test("shows preview and download for one object without write controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          { kind: "prefix", prefix: "photos/" },
          objectRow("a.txt", 1, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      ),
    ),
  );
  renderObjects("bkt-1", { canWrite: false, canTransfer: true });
  expect(await screen.findByRole("checkbox", { name: "Select a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  const preview = screen.getByRole("link", { name: "Preview" });
  const download = screen.getByRole("link", { name: "Download" });
  expect(preview.getAttribute("href")).toBe("/api/buckets/bkt-1/objects/a.txt?preview=1");
  expect(download.getAttribute("href")).toBe("/api/buckets/bkt-1/objects/a.txt?download=1");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

function rowOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const button = row.querySelector("button");
      return button?.textContent ?? "";
    });
}
