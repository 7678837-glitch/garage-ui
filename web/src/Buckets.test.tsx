import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

function renderBuckets() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

test("shows the bucket id and string aliases without letting an alias hide the id", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/buckets?");
      expect(init?.credentials).toBe("include");
      return json({
        items: [
          {
            id: "bkt-1",
            globalAliases: ["east", "a&b=c"],
            localAliases: ["west", { accessKeyId: "GK", alias: "site" }, 4],
          },
          { id: "bkt-2" },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets();
  expect(await screen.findByText("bkt-1")).toBeTruthy();
  expect(screen.getByText("bkt-2")).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByText("west")).toBeTruthy();
  expect(screen.getByText("site")).toBeTruthy();
  expect(screen.queryByText("GK")).toBeNull();
  expect(screen.queryByText("4")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("loads the next page at the offset after the rows already shown", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      const offset = url.searchParams.get("offset");
      if (offset === "0") {
        return json({
          items: [{ id: "first", globalAliases: ["a&b=c"] }],
          hasMore: true,
        });
      }
      if (offset === "1") {
        return json({
          items: [{ id: "second", localAliases: ["kept"] }],
          hasMore: false,
        });
      }
      return json({ message: "unexpected offset" }, 500);
    }),
  );
  renderBuckets();
  expect(await screen.findByText("first")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(calls.some((call) => call.startsWith("/api/buckets?offset=1"))).toBe(true);
  const limits = calls.map((call) => new URL(call, "http://ui.local").searchParams.get("limit"));
  expect(limits).toEqual([limits[0], limits[0]]);
});

test("shows the error message when the bucket list request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderBuckets();
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("keeps the loaded rows when the next page fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const offset = new URL(String(input), "http://ui.local").searchParams.get("offset");
      if (offset === "0") {
        return json({ items: [{ id: "first" }], hasMore: true });
      }
      return json({ message: "page failed" }, 502);
    }),
  );
  renderBuckets();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("page failed")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
});
