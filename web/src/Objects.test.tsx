import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";
import { Objects } from "./Objects";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderObjects(bucketId = "bkt-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Objects bucketId={bucketId} onBack={onBack} />
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
      <Buckets />
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

function rowOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const button = row.querySelector("button");
      return button?.textContent ?? "";
    });
}
