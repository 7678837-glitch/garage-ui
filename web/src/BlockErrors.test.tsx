import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function stubAdminBlockErrors() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/status")) {
        return new Response(
          JSON.stringify({
            initialized: true,
            authenticated: true,
            username: "Ada",
            role: "admin",
            can_download: true,
            can_share: true,
            garage_version: "v2.4.1",
            garage_write_blocked: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/nodes/n1/block-errors")) {
        return new Response(
          JSON.stringify([
            {
              blockHash: "aa11",
              refcount: 2,
              errorCount: 3,
              lastTrySecsAgo: 4,
              nextTryInSecs: 5,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
}

test("an admin opening #block-errors/n1 sees that node's block aa11", async () => {
  window.location.hash = "#block-errors/n1";
  stubAdminBlockErrors();
  renderApp();
  expect(await screen.findByText("aa11")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  expect(screen.getByText("4")).toBeTruthy();
  expect(screen.getByText("5")).toBeTruthy();
  expect(window.location.hash).toBe("#block-errors/n1");
});

function retryPosts(): { url: string; body: unknown }[] {
  return vi.mocked(fetch).mock.calls.flatMap(([input, init]) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || url !== "/api/nodes/n1/blocks/retry") {
      return [];
    }
    const raw = init?.body;
    return [{ url, body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw }];
  });
}

test("clicking Retry aa11 posts that one block hash", async () => {
  window.location.hash = "#block-errors/n1";
  stubAdminBlockErrors();
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Retry aa11" }));
  await waitFor(() => {
    expect(retryPosts()).toEqual([
      { url: "/api/nodes/n1/blocks/retry", body: { blockHashes: ["aa11"] } },
    ]);
  });
  expect(window.location.hash).toBe("#block-errors/n1");
});

test("clicking Retry all posts all true for that node", async () => {
  window.location.hash = "#block-errors/n1";
  stubAdminBlockErrors();
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Retry all" }));
  await waitFor(() => {
    expect(retryPosts()).toEqual([
      { url: "/api/nodes/n1/blocks/retry", body: { all: true } },
    ]);
  });
  expect(window.location.hash).toBe("#block-errors/n1");
});
