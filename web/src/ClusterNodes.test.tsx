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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const health = {
  status: "healthy",
  knownNodes: 2,
  connectedNodes: 2,
  storageNodes: 2,
  storageNodesUp: 1,
  partitions: 256,
  partitionsQuorum: 256,
  partitionsAllOk: 256,
};

function session(role: "admin" | "viewer") {
  return {
    initialized: true,
    authenticated: true,
    username: role === "admin" ? "Ada" : "Bea",
    role,
    can_download: role === "admin",
    can_share: role === "admin",
    garage_version: "v2.4.1",
    garage_write_blocked: false,
  };
}

function installFetch(role: "admin" | "viewer", statusResponse: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/status")) {
      return json(session(role));
    }
    if (url === "/api/cluster/status") {
      return statusResponse();
    }
    if (url === "/api/cluster/health") {
      return json(health);
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
  return fetchMock;
}

const listed = `{
  "layoutVersion": 9007199254740993,
  "nodes": [
    {
      "id": "node-up",
      "hostname": "alpha",
      "addr": "10.0.0.1:3901",
      "garageVersion": "v2.4.1",
      "isUp": true,
      "draining": false,
      "lastSeenSecsAgo": 9007199254740993,
      "role": { "zone": "dc1", "capacity": 9007199254740993, "tags": ["fast"] },
      "dataPartition": { "avail": 9007199254740993 },
      "metadataPartition": { "avail": 4 }
    },
    {
      "id": "node-down",
      "hostname": "",
      "addr": "",
      "garageVersion": "",
      "isUp": false,
      "draining": true
    }
  ]
}`;

test("shows an up node with a hostname and a down draining node", async () => {
  installFetch("admin", () => textResponse(listed));
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Nodes" })).toBeTruthy();
  expect(screen.getByText("alpha")).toBeTruthy();
  expect(screen.getByText("10.0.0.1:3901")).toBeTruthy();
  expect(screen.getByText("v2.4.1")).toBeTruthy();
  expect(screen.getByText("Up")).toBeTruthy();
  expect(screen.getByText("node-down")).toBeTruthy();
  expect(screen.getByText("Down")).toBeTruthy();
  expect(screen.getByText("Draining")).toBeTruthy();
  const up = screen.getByText("node-up").closest("li");
  const down = screen.getByText("node-down").closest("li");
  expect(up?.textContent).toBe("node-upalpha10.0.0.1:3901v2.4.1Up");
  expect(down?.textContent).toBe("node-downDownDraining");
  const page = document.body.textContent ?? "";
  expect(page).not.toContain("9007199254740993");
  expect(page).not.toContain("9007199254740992");
  expect(page).not.toContain("dc1");
  expect(page).not.toContain("fast");
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("says there are no nodes when the list is empty", async () => {
  installFetch("admin", () => json({ layoutVersion: 3, nodes: [] }));
  renderApp();
  const message = await screen.findByText("There are no nodes.");
  expect(message.tagName).toBe("P");
  expect(screen.getByRole("heading", { name: "Nodes" })).toBeTruthy();
  expect(screen.queryByText("Up")).toBeNull();
  expect(screen.queryByText("Down")).toBeNull();
});

test("says nodes are unavailable when an id is missing or empty", async () => {
  installFetch("admin", () => json({ nodes: [{ isUp: true, draining: false }] }));
  renderApp();
  const missing = await screen.findByText("Nodes are unavailable");
  expect(missing.tagName).toBe("P");
  expect(missing.getAttribute("role")).toBeNull();
  expect(screen.queryByText("Up")).toBeNull();
  cleanup();
  installFetch("admin", () => json({ nodes: [{ id: "", isUp: true, draining: false }] }));
  renderApp();
  const empty = await screen.findByText("Nodes are unavailable");
  expect(empty.tagName).toBe("P");
  expect(empty.getAttribute("role")).toBeNull();
  expect(screen.queryByText("There are no nodes.")).toBeNull();
  expect(screen.queryByText("Up")).toBeNull();
});

test("shows the cluster status API message without an alert", async () => {
  installFetch("admin", () =>
    json({ code: "garage_unavailable", message: "Garage admin API is not reachable" }, 502),
  );
  renderApp();
  const message = await screen.findByText("Garage admin API is not reachable");
  expect(message.tagName).toBe("P");
  expect(message.getAttribute("role")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("There are no nodes.")).toBeNull();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("does not show cluster nodes to a viewer or request them", async () => {
  const fetchMock = installFetch("viewer", () => textResponse(listed));
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(screen.queryByText("node-up")).toBeNull();
  expect(screen.queryByText("alpha")).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
});
