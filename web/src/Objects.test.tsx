import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";
import { Objects } from "./Objects";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

function renderObjects(
  bucketId = "bkt-1",
  access: { canWrite: boolean; canTransfer: boolean; canManage?: boolean } = {
    canWrite: true,
    canTransfer: true,
  },
  staleTime = 0,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } },
  });
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Objects
        bucketId={bucketId}
        onBack={onBack}
        canWrite={access.canWrite}
        canTransfer={access.canTransfer}
        canManage={access.canManage}
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

type ListedObject = {
  key: string;
  encodedKey: string;
  contentType: string;
  size?: number;
  lastModified?: string;
};

type FetchCall = {
  url: string;
  credentials: RequestCredentials | undefined;
  range: string | null;
};

// jsdom's Headers.append deletes Range, so read the header the caller passed.
function rangeHeader(headers: HeadersInit | undefined): string | null {
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    return null;
  }
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "range");
  if (name === undefined) {
    return null;
  }
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

function stubBucketObjects(rows: ListedObject[], previewBody = "preview-body") {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, credentials: init?.credentials, range: rangeHeader(init?.headers) });
      if (url.includes("preview=1")) {
        return new Response(previewBody, { status: 200 });
      }
      const row = rows.find((item) => url.includes(`/objects/${item.encodedKey}`));
      if (row) {
        return json({
          key: row.key,
          size: row.size ?? 4,
          etag: "abc",
          lastModified: row.lastModified ?? "2026-10-11T00:00:00Z",
          contentType: row.contentType,
        });
      }
      return json(
        page(
          rows.map((item) =>
            objectRow(item.key, item.size ?? 4, item.lastModified ?? "2026-10-11T00:00:00Z"),
          ),
        ),
      );
    }),
  );
  return calls;
}

function expectDownload(href: string) {
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  const download = screen.getByRole("link", { name: "Download" });
  expect(download.getAttribute("href")).toBe(href);
  expect(download.getAttribute("target")).toBe("_blank");
  expect(download.getAttribute("rel")).toBe("noopener");
}

function expectNoViewer() {
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(document.querySelector("img, pre, iframe, video, audio")).toBeNull();
}

test("keeps upload collapsed until opened and preserves jobs when closed", async () => {
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
  const summary = screen.getByText("Upload", { selector: "summary" });
  const disclosure = summary.closest("details");
  expect(disclosure?.open).toBe(false);
  fireEvent.click(summary);
  expect(disclosure?.open).toBe(true);
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
  fireEvent.click(summary);
  expect(disclosure?.open).toBe(false);
  expect(screen.getByRole("button", { name: "photos/a.txt" })).toBe(objectButton);
  fireEvent.click(summary);
  expect(disclosure?.open).toBe(true);
  expect(screen.getByRole("region", { name: "Upload" })).toBe(upload);
  expect(within(upload).getByText("photos/a.txt").closest("li")).toBe(objectFile);
  expect(within(upload).getByText("photos/").closest("li")).toBe(prefixFile);
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
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/auth/status") {
        return json({ can_share: false });
      }
      const prefix = url.searchParams.get("prefix") ?? "";
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
  expect(screen.getByLabelText("Loading objects")).toBeTruthy();
  expect(screen.queryByText("Loading objects")).toBeNull();
  expect(screen.queryByText("There are no objects. Upload the first object.")).toBeNull();
  release(json(page([])));
  expect(await screen.findByText("There are no objects. Upload the first object.")).toBeTruthy();
  fireEvent.click(screen.getByText("Upload", { selector: "summary" }));
  expect(screen.getAllByRole("region", { name: "Upload" })).toHaveLength(1);
  expect(screen.queryByLabelText("Loading objects")).toBeNull();
  expect(screen.queryByText("Loading objects")).toBeNull();
  expect(screen.getByRole("region", { name: "Objects" }).getAttribute("aria-busy")).toBe("false");
});

test("says there are no objects and hides upload when the viewer cannot write", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(page([]))),
  );
  renderObjects("bkt-1", { canWrite: false, canTransfer: false });
  expect(await screen.findByText("There are no objects.")).toBeTruthy();
  expect(screen.queryByText("There are no objects. Upload the first object.")).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  expect(screen.queryByLabelText("Loading objects")).toBeNull();
  expect(screen.queryByText("Loading objects")).toBeNull();
});

test("keeps the short empty sentence when a search has no matches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname.endsWith("/search")) {
        return json({ matches: [], truncated: false, reason: null });
      }
      return json(listed("listed.txt"));
    }),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "listed.txt" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zz" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("There are no objects.")).toBeTruthy();
  expect(screen.queryByText("There are no objects. Upload the first object.")).toBeNull();
  expect(screen.queryByRole("button", { name: "listed.txt" })).toBeNull();
  fireEvent.click(screen.getByText("Upload", { selector: "summary" }));
  expect(screen.getAllByRole("region", { name: "Upload" })).toHaveLength(1);
});

test("shows the error message and loads again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/auth/status")) {
        return json({ can_share: false });
      }
      calls += 1;
      if (calls === 1) {
        return json({ code: "upstream_failed", message: "Garage returned an error" }, 502);
      }
      return json(listed("back.txt"));
    }),
  );
  renderObjects();
  expect(await screen.findByText("Garage returned an error")).toBeTruthy();
  expect(screen.getByText("upstream_failed")).toBeTruthy();
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no objects. Upload the first object.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "back.txt" })).toBeTruthy();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByText("upstream_failed")).toBeNull();
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

test("shows Download only for one selected object and does not offer Preview", async () => {
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
  expectNoViewer();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select dir/a?b.txt" }));
  expectDownload("/api/buckets/b%20k/objects/dir/a%3Fb.txt?download=1");
  expect(calls.some((call) => call.includes("preview=1") || call.includes("download=1"))).toBe(
    false,
  );
  expectNoViewer();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expectNoViewer();
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("shows Download ZIP for two selected objects and requests the archive once", async () => {
  const calls: { url: string; method: string; body: string | null }[] = [];
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
        return json({ token: "zip-token-1" });
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
  expect(await screen.findByRole("checkbox", { name: "Select a.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download ZIP" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download ZIP" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.queryByRole("button", { name: "Download ZIP" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download ZIP" })).toBeNull();
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    "/api/buckets/bkt-1/objects/a.txt?download=1",
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download ZIP" }));
  await waitFor(() => {
    const archive = document.querySelector('a[href*="archive?token="]');
    expect(archive?.getAttribute("href")).toContain("/api/buckets/bkt-1/archive?token=zip-token-1");
  });
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    {
      url: "/api/buckets/bkt-1/archive-token",
      method: "POST",
      body: JSON.stringify({ keys: ["a.txt", "b.txt"] }),
    },
  ]);
  expect(calls.some((call) => call.url.includes("archive?token="))).toBe(false);
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
      if (raw.includes("preview=1")) {
        return new Response("secret bytes", { status: 200 });
      }
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
  expect(screen.queryByText("secret bytes")).toBeNull();
  expectNoViewer();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  expect(await screen.findByText("text/plain")).toBeTruthy();
  expect(screen.queryByText("secret bytes")).toBeNull();
  expectNoViewer();
});

test("shows the text viewer and Download for one object without write controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("preview=1")) {
        return new Response("readable note", { status: 200 });
      }
      if (url.includes("/objects/a.txt")) {
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
          objectRow("b.txt", 2, "2026-10-12T00:00:00Z"),
        ]),
      );
    }),
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
  expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
  const note = await screen.findByText("readable note");
  expect(note.tagName).toBe("PRE");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expect(screen.queryByText("readable note")).toBeNull();
  expectNoViewer();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("shows Working while an object delete is submitting", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        expect(String(input)).toBe("/api/buckets/bkt-1/objects/a.txt");
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json(page([objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  const working = (await within(dialog).findByRole("button", { name: "Working" })) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(working.textContent).toBe("Working");
  expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  expect(screen.getByRole("button", { name: "a.txt" })).toBeTruthy();
  release(new Response(null, { status: 204 }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("shows Working while a batch delete is submitting", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return new Promise<Response>((resolve) => {
          release = resolve;
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
  const typed = within(dialog).getByRole("textbox") as HTMLInputElement;
  fireEvent.change(typed, { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  const working = (await within(dialog).findByRole("button", { name: "Working" })) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(typed.value).toBe("2");
  expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "b.txt" })).toBeTruthy();
  release(json({ deleted: ["a.txt", "b.txt"], failed: [] }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("shows Working while a prefix delete is submitting", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json(
        page([{ kind: "prefix", prefix: "photos/" }, objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]),
      );
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
  const dialog = screen.getByRole("dialog");
  const typed = within(dialog).getByRole("textbox") as HTMLInputElement;
  fireEvent.change(typed, { target: { value: "photos/" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  const working = (await within(dialog).findByRole("button", { name: "Working" })) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(typed.value).toBe("photos/");
  expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  release(json({ deleted: 1, errors: [] }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
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

async function expectFields(contentType: string, size: number) {
  const details = await screen.findByRole("region", { name: "Object details" });
  expect(details.textContent).toContain(`Size ${size}`);
  expect(details.textContent).toContain(`Content type ${contentType}`);
  expect(details.textContent).toContain("ETag abc");
  expect(details.textContent).toContain("Last modified 2026-10-11T00:00:00Z");
  return details;
}

test("renders one text object inline from the preview URL without truncating it", async () => {
  const body = `${"n".repeat(200)}\n<script>alert(1)</script>`;
  const contentType = "Text/Plain; charset=utf-8";
  const calls = stubBucketObjects(
    [
      {
        key: "dir/a?b.txt",
        encodedKey: "dir/a%3Fb.txt",
        contentType,
        size: 4,
      },
    ],
    body,
  );
  renderObjects("b k");
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select dir/a?b.txt" }));
  expectDownload("/api/buckets/b%20k/objects/dir/a%3Fb.txt?download=1");
  const details = await expectFields(contentType, 4);
  await waitFor(() => {
    expect(details.querySelector("pre")?.textContent).toBe(body);
  });
  const pre = details.querySelector("pre");
  if (!(pre instanceof HTMLPreElement)) {
    throw new Error("missing text preview");
  }
  expect(pre.textContent).toBe(body);
  expect(pre.querySelector("script")).toBeNull();
  const previewUrl = "/api/buckets/b%20k/objects/dir/a%3Fb.txt?preview=1";
  const metadataUrl = "/api/buckets/b%20k/objects/dir/a%3Fb.txt";
  const metadataAt = calls.findIndex((call) => call.url === metadataUrl);
  const previewAt = calls.findIndex((call) => call.url === previewUrl);
  expect(metadataAt).toBeGreaterThanOrEqual(0);
  expect(previewAt).toBeGreaterThan(metadataAt);
  expect(calls.filter((call) => call.url.includes("preview=1"))).toEqual([
    { url: previewUrl, credentials: "include", range: "bytes=0-262143" },
  ]);
  expect(calls.some((call) => call.url.includes("download=1"))).toBe(false);
});

test("large text loads the beginning and the previous load is cancelled", async () => {
  type PreviewCall = {
    url: string;
    method: string;
    range: string | null;
    signal: AbortSignal | null;
  };
  const previewCalls: PreviewCall[] = [];
  const pending = new Map<string, (response: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("preview=1")) {
        previewCalls.push({
          url,
          method,
          range: rangeHeader(init?.headers),
          signal: init?.signal ?? null,
        });
        return new Promise<Response>((resolve) => {
          pending.set(url, resolve);
        });
      }
      const key = ["a.txt", "b.txt", "c.txt"].find((item) => url.endsWith(`/objects/${item}`));
      if (key) {
        return json({
          key,
          size: 4,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        });
      }
      return json(
        page([
          objectRow("a.txt", 4, "2026-10-11T00:00:00Z"),
          objectRow("b.txt", 4, "2026-10-11T00:00:00Z"),
          objectRow("c.txt", 4, "2026-10-11T00:00:00Z"),
        ]),
      );
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  await waitFor(() => {
    expect(previewCalls.some((call) => call.url.endsWith("/objects/a.txt?preview=1"))).toBe(true);
  });
  const first = previewCalls.find((call) => call.url.endsWith("/objects/a.txt?preview=1"));
  if (!first) {
    throw new Error("missing text preview");
  }
  expect(first.method).toBe("GET");
  expect(first.range).toBe("bytes=0-262143");
  if (!first.signal) {
    throw new Error("missing text preview");
  }
  expect(first.signal.aborted).toBe(false);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  await waitFor(() => {
    expect(previewCalls.some((call) => call.url.endsWith("/objects/b.txt?preview=1"))).toBe(true);
  });
  expect(first.signal.aborted).toBe(true);
  expect(previewCalls.filter((call) => call.url.endsWith("/objects/a.txt?preview=1")).length).toBe(1);

  const second = previewCalls.find((call) => call.url.endsWith("/objects/b.txt?preview=1"));
  if (!second) {
    throw new Error("missing text preview");
  }
  expect(second.method).toBe("GET");
  expect(second.range).toBe("bytes=0-262143");
  const releaseSecond = pending.get(second.url);
  if (!releaseSecond) {
    throw new Error("missing text preview");
  }
  releaseSecond(new Response("hello", { status: 206 }));
  expect((await screen.findByText("hello")).tagName).toBe("PRE");
  const note = screen.getByText("Showing the first 256 KiB.");
  expect(note.tagName).toBe("P");
  expect(note.textContent).toBe("Showing the first 256 KiB.");
  expect(previewCalls.filter((call) => call.url.endsWith("/objects/b.txt?preview=1")).length).toBe(1);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select c.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  await waitFor(() => {
    expect(previewCalls.some((call) => call.url.endsWith("/objects/c.txt?preview=1"))).toBe(true);
  });
  const third = previewCalls.find((call) => call.url.endsWith("/objects/c.txt?preview=1"));
  if (!third) {
    throw new Error("missing text preview");
  }
  expect(third.method).toBe("GET");
  expect(third.range).toBe("bytes=0-262143");
  const releaseThird = pending.get(third.url);
  if (!releaseThird) {
    throw new Error("missing text preview");
  }
  releaseThird(new Response("whole", { status: 200 }));
  expect((await screen.findByText("whole")).tagName).toBe("PRE");
  expect(screen.queryByText("Showing the first 256 KiB.")).toBeNull();
  expect(previewCalls.filter((call) => call.url.endsWith("/objects/c.txt?preview=1")).length).toBe(1);
});

const imageTypes = [
  "image/png; charset=binary",
  "Image/JPEG",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];

for (const contentType of imageTypes) {
  test(`renders one ${contentType} object in an image`, async () => {
    const calls = stubBucketObjects([
      { key: "a.txt", encodedKey: "a.txt", contentType, size: 9 },
    ]);
    renderObjects();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
    expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
    const details = await expectFields(contentType, 9);
    const image = within(details).getByRole("img", { name: "a.txt" });
    expect(image.getAttribute("src")).toBe("/api/buckets/bkt-1/objects/a.txt?preview=1");
    expect(calls.some((call) => call.url.includes("preview=1"))).toBe(false);
  });
}

test("renders one PDF in a sandboxed frame that does not grant same origin", async () => {
  const calls = stubBucketObjects([
    { key: "a.txt", encodedKey: "a.txt", contentType: "application/pdf", size: 9 },
  ]);
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
  const details = await expectFields("application/pdf", 9);
  const frame = within(details).getByTitle("a.txt");
  expect(frame.tagName).toBe("IFRAME");
  expect(frame.getAttribute("src")).toBe("/api/buckets/bkt-1/objects/a.txt?preview=1");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(calls.some((call) => call.url.includes("preview=1"))).toBe(false);
});

for (const contentType of ["video/mp4", "video/webm"]) {
  test(`renders one ${contentType} object in a video with controls`, async () => {
    const calls = stubBucketObjects([
      { key: "a.txt", encodedKey: "a.txt", contentType, size: 9 },
    ]);
    renderObjects();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
    expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
    const details = await expectFields(contentType, 9);
    const video = details.querySelector("video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error(`missing video for ${contentType}`);
    }
    expect(video.getAttribute("src")).toBe("/api/buckets/bkt-1/objects/a.txt?preview=1");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(calls.some((call) => call.url.includes("preview=1"))).toBe(false);
  });
}

for (const contentType of ["audio/mpeg", "audio/ogg", "audio/wav"]) {
  test(`renders one ${contentType} object in an audio element with controls`, async () => {
    const calls = stubBucketObjects([
      { key: "a.txt", encodedKey: "a.txt", contentType, size: 9 },
    ]);
    renderObjects();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
    expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
    const details = await expectFields(contentType, 9);
    const audio = details.querySelector("audio");
    if (!(audio instanceof HTMLAudioElement)) {
      throw new Error(`missing audio for ${contentType}`);
    }
    expect(audio.getAttribute("src")).toBe("/api/buckets/bkt-1/objects/a.txt?preview=1");
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(calls.some((call) => call.url.includes("preview=1"))).toBe(false);
  });
}

for (const contentType of [
  "text/html",
  "text/html; charset=utf-8",
  "image/svg+xml",
  "",
  "application/zip",
]) {
  test(`does not preview ${contentType === "" ? "an empty type" : contentType}`, async () => {
    const calls = stubBucketObjects([
      { key: "a.txt", encodedKey: "a.txt", contentType, size: 9 },
    ]);
    renderObjects();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
    expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
    const details = await expectFields(contentType, 9);
    expect(details.querySelector("img, pre, iframe, video, audio")).toBeNull();
    expect(calls.some((call) => call.url.includes("preview=1"))).toBe(false);
  });
}

test("keeps Download and hides the viewer until object metadata loads", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("preview=1")) {
        return new Response("loaded body", { status: 200 });
      }
      if (url.includes("/objects/a.txt")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json(page([objectRow("a.txt", 4, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  expectDownload("/api/buckets/bkt-1/objects/a.txt?download=1");
  expect(screen.queryByRole("region", { name: "Object details" })).toBeNull();
  expectNoViewer();
  release(
    json({
      key: "a.txt",
      size: 4,
      etag: "abc",
      lastModified: "2026-10-11T00:00:00Z",
      contentType: "text/plain",
    }),
  );
  expect((await screen.findByText("loaded body")).tagName).toBe("PRE");
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
});

test("shares one object after an admin chooses the bucket key", async () => {
  const calls: { url: string; method: string; body: string | null }[] = [];
  let chosen = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ url, method, body });
      if (url.startsWith("/api/auth/status")) {
        return json({ can_share: true, role: "admin" });
      }
      if (url.startsWith("/api/keys")) {
        return json({ items: [{ id: "CHOSEN" }], hasMore: false });
      }
      if (method === "PUT" && url === "/api/buckets/bkt-1/credential") {
        chosen = true;
        return json({ access_key_id: "CHOSEN" });
      }
      if (method === "POST" && url === "/api/share") {
        return json({
          url: "http://127.0.0.1:3901/bkt-1/a.txt?X-Amz-Expires=3600",
          expires_in: 3600,
          website_url: "https://bkt-1.web.example",
        });
      }
      if (!chosen && url.includes("/api/buckets/bkt-1/objects")) {
        return json(
          { code: "no_usable_key", message: "This bucket has no usable read-write key" },
          412,
        );
      }
      return json(page([objectRow("a.txt", 1, "2026-10-11T00:00:00Z")]));
    }),
  );
  renderObjects();
  expect(await screen.findByText("no_usable_key")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Share for 1 hour" })).toBeNull();
  fireEvent.change(await screen.findByLabelText("Bucket key"), { target: { value: "CHOSEN" } });
  fireEvent.click(screen.getByRole("button", { name: "Use this key" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Share for 1 hour" }));
  expect(
    await screen.findByText("http://127.0.0.1:3901/bkt-1/a.txt?X-Amz-Expires=3600"),
  ).toBeTruthy();
  expect(screen.getByText("https://bkt-1.web.example")).toBeTruthy();
  expect(calls.find((call) => call.url === "/api/share")?.body).toBe(
    JSON.stringify({ ttl_seconds: 3600, bucket: "bkt-1", key: "a.txt" }),
  );
  expect(calls.find((call) => call.method === "PUT")?.body).toBe(
    JSON.stringify({ access_key_id: "CHOSEN" }),
  );
});

test("an admin inspecting photos/cat.jpg sees version u1", async () => {
  window.location.hash = "#buckets/bkt-1/photos/";
  const inspectUrl = "/api/buckets/bkt-1/inspect/photos/cat.jpg";
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      calls.push({ url: url.pathname, method: (init?.method ?? "GET").toUpperCase() });
      if (url.pathname === "/api/buckets/bkt-1/objects") {
        return json(page([objectRow("photos/cat.jpg", 1, "2026-10-11T00:00:00Z")], null, "photos/"));
      }
      if (url.pathname === inspectUrl) {
        return json({
          bucketId: "bkt-1",
          key: "photos/cat.jpg",
          versions: [
            {
              uuid: "u1",
              timestamp: "2026-10-11T00:00:00Z",
              encrypted: false,
              uploading: false,
              aborted: false,
              deleteMarker: false,
              inline: true,
            },
          ],
        });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderObjects();
  expect(await screen.findByRole("button", { name: "photos/cat.jpg" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Inspect photos/cat.jpg" })).toBeNull();
  cleanup();
  renderObjects("bkt-1", { canWrite: true, canTransfer: true, canManage: true });
  const inspect = await screen.findByRole("button", { name: "Inspect photos/cat.jpg" });
  expect(calls.filter((call) => call.url.includes("/inspect/"))).toEqual([]);
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/");
  fireEvent.click(inspect);
  expect((await screen.findByText("u1")).textContent).toBe("u1");
  expect(screen.getByText("encrypted no").textContent).toBe("encrypted no");
  expect(screen.getByText("uploading no").textContent).toBe("uploading no");
  expect(screen.getByText("aborted no").textContent).toBe("aborted no");
  expect(screen.getByText("deleteMarker no").textContent).toBe("deleteMarker no");
  expect(screen.getByText("inline yes").textContent).toBe("inline yes");
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/");
  expect(calls.filter((call) => call.url.includes("/inspect/"))).toEqual([
    { url: inspectUrl, method: "GET" },
  ]);
});

test("left and right keys select the previous and next object in the same directory", async () => {
  window.location.hash = "#buckets/bkt-1/photos/";
  const prefixes: string[] = [];
  const keys = ["photos/a.txt", "photos/b.txt", "photos/c.txt"] as const;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/auth/status") {
        return json({ can_share: false });
      }
      if (url.searchParams.get("preview") === "1") {
        return new Response("note", { status: 200 });
      }
      if (url.pathname === "/api/buckets/bkt-1/objects") {
        const prefix = url.searchParams.get("prefix") ?? "";
        prefixes.push(prefix);
        return json(
          page(
            [
              { kind: "prefix", prefix: "photos/album/" },
              objectRow("photos/a.txt", 1, "2026-10-11T00:00:00Z"),
              objectRow("photos/b.txt", 2, "2026-10-12T00:00:00Z"),
              objectRow("photos/c.txt", 3, "2026-10-13T00:00:00Z"),
            ],
            null,
            prefix,
          ),
        );
      }
      const sizes: Record<string, number> = {
        "/api/buckets/bkt-1/objects/photos/a.txt": 1,
        "/api/buckets/bkt-1/objects/photos/b.txt": 2,
        "/api/buckets/bkt-1/objects/photos/c.txt": 3,
      };
      const size = sizes[url.pathname];
      if (size === undefined) {
        return json({ message: "unexpected" }, 500);
      }
      const key = url.pathname.slice("/api/buckets/bkt-1/objects/".length);
      return json({
        key,
        size,
        etag: "abc",
        lastModified: "2026-10-11T00:00:00Z",
        contentType: "text/plain",
      });
    }),
  );
  renderObjects();

  function expectDirectory() {
    expect(window.location.hash).toBe("#buckets/bkt-1/photos/");
    expect(window.location.search).toBe("");
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.every((prefix) => prefix === "photos/")).toBe(true);
    expect(screen.getByRole("button", { name: "photos/album/" })).toBeTruthy();
    for (const key of keys) {
      expect(screen.getByRole("button", { name: key })).toBeTruthy();
    }
  }

  function expectSelected(key: string) {
    for (const item of keys) {
      expect(box(`Select ${item}`).checked).toBe(item === key);
    }
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      `/api/buckets/bkt-1/objects/${key}?download=1`,
    );
  }

  async function expectSize(size: number) {
    const details = await screen.findByRole("region", { name: "Object details" });
    await waitFor(() => {
      expect(details.textContent).toContain(`Size ${size}`);
    });
  }

  expect(await screen.findByRole("checkbox", { name: "Select photos/b.txt" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select photos/b.txt" }));
  expectSelected("photos/b.txt");
  await expectSize(2);
  expectDirectory();

  fireEvent.keyDown(window, { key: "ArrowRight" });
  expectSelected("photos/c.txt");
  await expectSize(3);
  expectDirectory();

  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expectSelected("photos/b.txt");
  await expectSize(2);
  expectDirectory();

  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expectSelected("photos/a.txt");
  await expectSize(1);
  expectDirectory();

  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expectSelected("photos/a.txt");
  expectDirectory();

  fireEvent.keyDown(window, { key: "ArrowRight" });
  expectSelected("photos/b.txt");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expectSelected("photos/c.txt");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expectSelected("photos/c.txt");
  await expectSize(3);
  expectDirectory();
});

function exactName(key: string): RegExp {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

test("shows a thumbnail for an allowlisted bitmap and does not request one without download permission", async () => {
  const bitmap = [
    "shot.png",
    "shot.jpg",
    "shot.jpeg",
    "shot.gif",
    "shot.webp",
    "shot.avif",
    "shot.bmp",
    "shot.ico",
    "shot.PNG",
    "dir/nested.jpeg",
  ];
  const plain = ["note.txt", "page.svg", "archive.png.txt", "readme"];
  const keys = [...bitmap, ...plain];
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json(page(keys.map((key) => objectRow(key, 4, "2026-10-11T00:00:00Z"))));
    }),
  );
  renderObjects("bkt 1", { canWrite: false, canTransfer: true });
  expect(await screen.findByRole("button", { name: exactName("shot.png") })).toBeTruthy();
  for (const key of bitmap) {
    const row = screen.getByRole("button", { name: exactName(key) }).closest("tr");
    if (!(row instanceof HTMLTableRowElement)) {
      throw new Error(`missing row ${key}`);
    }
    const img = row.querySelector("img");
    if (!(img instanceof HTMLImageElement)) {
      throw new Error(`missing thumbnail ${key}`);
    }
    const encoded = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    expect(img.getAttribute("src")).toBe(
      `/api/buckets/${encodeURIComponent("bkt 1")}/objects/${encoded}?thumbnail=1`,
    );
  }
  for (const key of plain) {
    const row = screen.getByRole("button", { name: exactName(key) }).closest("tr");
    expect(row?.querySelector("img, svg")).toBeNull();
  }
  const pngRow = screen.getByRole("button", { name: exactName("shot.png") }).closest("tr");
  const png = pngRow?.querySelector("img");
  if (!(png instanceof HTMLImageElement) || !(pngRow instanceof HTMLTableRowElement)) {
    throw new Error("missing shot.png thumbnail");
  }
  fireEvent.error(png);
  expect(pngRow.querySelector("img")).toBeNull();
  expect(pngRow.querySelector("svg")).not.toBeNull();

  cleanup();
  calls.length = 0;
  renderObjects("bkt 1", { canWrite: false, canTransfer: false });
  expect(await screen.findByRole("button", { name: exactName("shot.png") })).toBeTruthy();
  expect(document.querySelector("img, svg")).toBeNull();
  expect(calls.some((url) => url.includes("thumbnail=1"))).toBe(false);
  for (const key of bitmap) {
    const row = screen.getByRole("button", { name: exactName(key) }).closest("tr");
    expect(row?.querySelector("img")).toBeNull();
  }
});

test.each(["single", "batch", "partial"])("refreshes rendered search after %s deletion", async (mode) => {
  const initial = [objectRow("a.txt", 1, "2026-10-11T00:00:00Z"), objectRow("b.txt", 2, "2026-10-11T00:00:00Z")];
  let written = false;
  let searches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE" || init?.method === "POST") {
      written = true;
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ deleted: ["a.txt"], failed: mode === "partial" ? [{ key: "b.txt", message: "denied" }] : [] });
    }
    if (String(input).includes("/search?")) {
      searches += 1;
      return json({ matches: written ? (mode === "batch" ? [] : initial.slice(1)) : initial, truncated: false, reason: null });
    }
    return json(page(initial));
  }));
  renderObjects();
  await screen.findByRole("button", { name: "a.txt" });
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "txt" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(searches).toBe(1));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  if (mode !== "single") fireEvent.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  if (mode !== "single") fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "a.txt" })).toBeNull());
  expect(searches).toBe(2);
  if (mode === "partial") expect(screen.getByRole("dialog").textContent).toContain("b.txt: denied");
});

test("refreshes a previously rendered search after prefix deletion", async () => {
  let deleted = false;
  let searches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") { deleted = true; return json({ deleted: 1, errors: [] }); }
    if (String(input).includes("/search?")) { searches += 1; return json({ matches: deleted ? [] : [objectRow("folder/a.txt", 1, "2026-10-11T00:00:00Z")], truncated: false }); }
    return json(page(deleted ? [] : [{ kind: "prefix", prefix: "folder/" }]));
  }));
  renderObjects("bkt-1", { canWrite: true, canTransfer: true }, Infinity);
  await screen.findByRole("button", { name: "folder/" });
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "txt" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: "folder/a.txt" });
  fireEvent.click(screen.getByRole("button", { name: "bkt-1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "folder/" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "txt" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "folder/a.txt" })).toBeNull());
  expect(searches).toBe(2);
});

