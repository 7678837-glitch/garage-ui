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

function stubAdminWorkers() {
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
      if (url.includes("/api/nodes/n1/workers")) {
        return new Response(
          JSON.stringify([
            {
              id: 7,
              name: "block_resync",
              state: "busy",
              errors: 3,
              progress: "1/4",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
}

test("an admin opening #workers/n1 sees that node's block_resync worker", async () => {
  window.location.hash = "#workers/n1";
  stubAdminWorkers();
  renderApp();
  expect(await screen.findByText("block_resync")).toBeTruthy();
  expect(screen.getByText("busy")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  expect(screen.getByText("1/4")).toBeTruthy();
  expect(window.location.hash).toBe("#workers/n1");
});

test("checking Busy only shows only the busy worker", async () => {
  window.location.hash = "#workers/n1";
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
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
      if (url.includes("/api/nodes/n1/workers")) {
        const rows = url.includes("busy=1")
          ? [
              {
                id: 7,
                name: "block_resync",
                state: "busy",
                errors: 3,
                progress: "1/4",
              },
            ]
          : [
              {
                id: 8,
                name: "block_rc",
                state: "idle",
                errors: 0,
                progress: "",
              },
              {
                id: 7,
                name: "block_resync",
                state: "busy",
                errors: 3,
                progress: "1/4",
              },
            ];
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("block_rc")).toBeTruthy();
  expect(screen.getByText("idle")).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.getByText("busy")).toBeTruthy();
  const seen = urls.length;
  fireEvent.click(screen.getByRole("checkbox", { name: "Busy only" }));
  await waitFor(() => {
    expect(screen.queryByText("block_rc")).toBeNull();
    expect(screen.getByText("block_resync")).toBeTruthy();
  });
  expect(screen.queryByText("idle")).toBeNull();
  expect(screen.getByText("busy")).toBeTruthy();
  const refetch = urls
    .slice(seen)
    .filter((url) => url.includes("/api/nodes/n1/workers") && url.includes("busy=1"));
  expect(refetch).toEqual(["/api/nodes/n1/workers?busy=1"]);
  expect(window.location.hash).toBe("#workers/n1");
});
