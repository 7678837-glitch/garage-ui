import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function session(role: "admin" | "viewer", writeBlocked = false) {
  return {
    initialized: true,
    authenticated: true,
    username: role === "admin" ? "Ada" : "Bea",
    role,
    can_download: role === "admin",
    can_share: role === "admin",
    garage_version: writeBlocked ? "v2.2.0" : "v2.4.1",
    garage_write_blocked: writeBlocked,
  };
}

function valueOf(label: string): string {
  const term = screen.getByText(label);
  expect(term.tagName).toBe("DT");
  const value = term.nextElementSibling;
  expect(value?.tagName).toBe("DD");
  return value?.textContent ?? "";
}

const report = {
  status: "degraded",
  knownNodes: 5,
  connectedNodes: 4,
  storageNodes: 3,
  storageNodesUp: 2,
  partitions: 256,
  partitionsQuorum: 250,
  partitionsAllOk: 240,
};

test("shows the status word and the seven cluster health counts to an admin", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/status")) {
      return json(session("admin"));
    }
    if (url === "/api/cluster/health") {
      return json(report);
    }
    if (url.includes("/healthz")) {
      return json({ status: "ok", version: "test" });
    }
    if (url.includes("/api/buckets") || url.includes("/api/keys")) {
      return json({ items: [], hasMore: false });
    }
    if (url.includes("/api/users")) {
      return json([]);
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByText("degraded")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Cluster health" })).toBeTruthy();
  expect(valueOf("Status")).toBe("degraded");
  expect(valueOf("Known nodes")).toBe("5");
  expect(valueOf("Connected nodes")).toBe("4");
  expect(valueOf("Storage nodes")).toBe("3");
  expect(valueOf("Storage nodes up")).toBe("2");
  expect(valueOf("Partitions")).toBe("256");
  expect(valueOf("Partitions with quorum")).toBe("250");
  expect(valueOf("Partitions all ok")).toBe("240");
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(fetchMock.mock.calls.some((entry) => entry[0] === "/api/cluster/health")).toBe(true);
});

test("shows the cluster health API message and leaves the version alert as the only alert", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/status")) {
        return json(session("admin", true));
      }
      if (url === "/api/cluster/health") {
        return json(
          { code: "garage_unavailable", message: "Garage admin API is not reachable" },
          502,
        );
      }
      if (url.includes("/healthz")) {
        return json({ status: "ok", version: "test" });
      }
      if (url.includes("/api/buckets") || url.includes("/api/keys")) {
        return json({ items: [], hasMore: false });
      }
      if (url.includes("/api/users")) {
        return json([]);
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  const message = await screen.findByText("Garage admin API is not reachable");
  expect(message.tagName).toBe("P");
  expect(message.getAttribute("role")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("degraded")).toBeNull();
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage v2.3.0 or newer is required");
});

test("does not show cluster health to a viewer or request it", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/status")) {
      return json(session("viewer"));
    }
    if (url === "/api/cluster/health") {
      return json(report);
    }
    if (url.includes("/healthz")) {
      return json({ status: "ok", version: "test" });
    }
    if (url.includes("/api/buckets") || url.includes("/api/keys")) {
      return json({ items: [], hasMore: false });
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByText("degraded")).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
});
