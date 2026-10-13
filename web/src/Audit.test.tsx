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

function stubAdminAudit() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
    if (url.includes("/api/audit/export")) {
      return new Response("at,username,ip,result,reason,method,path,target,status\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    if (url.includes("/api/audit")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              at: 1700000000,
              username: "Ada",
              ip: "127.0.0.1",
              result: "success",
              reason: "login",
              method: "POST",
              path: "/api/auth/login",
              target: "",
              status: 200,
            },
          ],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("an admin on #audit sees Ada and login", async () => {
  window.location.hash = "#audit";
  const fetchMock = stubAdminAudit();
  renderApp();
  expect(await screen.findByText("Ada")).toBeTruthy();
  expect(screen.getByText("login")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Audit" }).getAttribute("href")).toBe("#audit");
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  await waitFor(() => {
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/audit/export")).toBe(true);
  });
});
