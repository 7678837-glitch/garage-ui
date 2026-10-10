import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Keys } from "./Keys";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

function renderKeys() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Keys />
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("shows the key id and a string name without showing a secret or a non-string name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(init?.credentials).toBe("include");
      expect(init?.method ?? "GET").toBe("GET");
      return json({
        items: [
          { id: "key-1", name: "a&b=c", secretAccessKey: "SECRETVALUE" },
          { id: "key-2", name: { display: "hidden-name" } },
          { id: "key-3", name: 9157 },
          { id: "key-4" },
        ],
        hasMore: false,
      });
    }),
  );
  renderKeys();
  expect(await screen.findByText("key-1")).toBeTruthy();
  expect(screen.getByText("key-2")).toBeTruthy();
  expect(screen.getByText("key-3")).toBeTruthy();
  expect(screen.getByText("key-4")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(screen.queryByText("hidden-name")).toBeNull();
  expect(screen.queryByText("9157")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("loads the next page at the offset after the rows already shown", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      const offset = url.searchParams.get("offset");
      if (offset === "0") {
        return json({
          items: [
            { id: "first", name: "a&b=c" },
            { id: "middle", name: 9157 },
          ],
          hasMore: true,
        });
      }
      if (offset === "2") {
        return json({
          items: [{ id: "second", name: "kept" }],
          hasMore: false,
        });
      }
      return json({ message: "unexpected offset" }, 500);
    }),
  );
  renderKeys();
  expect(await screen.findByText("first")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.queryByText("9157")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(calls).toEqual([
    "/api/keys?offset=0&limit=100",
    "/api/keys?offset=2&limit=100",
  ]);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("shows the error message when the key list request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderKeys();
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("keeps the loaded rows when the next page fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const offset = new URL(String(input), "http://ui.local").searchParams.get("offset");
      if (offset === "0") {
        return json({ items: [{ id: "first", name: "kept" }], hasMore: true });
      }
      return json({ message: "page failed" }, 502);
    }),
  );
  renderKeys();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("page failed")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
});

test("does not render a page that contains a key without an id", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          { id: "key-ok", name: "visible", secretAccessKey: "SECRETVALUE" },
          { id: "", name: "skip-me", secretAccessKey: "OTHERSECRET" },
        ],
        hasMore: true,
      }),
    ),
  );
  renderKeys();
  expect(await screen.findByText("Keys are unavailable")).toBeTruthy();
  expect(screen.queryByText("key-ok")).toBeNull();
  expect(screen.queryByText("visible")).toBeNull();
  expect(screen.queryByText("skip-me")).toBeNull();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(screen.queryByText("OTHERSECRET")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});
