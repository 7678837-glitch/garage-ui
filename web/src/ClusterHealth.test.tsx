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

function textResponse(body: string, status = 200) {
  return new Response(body, { status });
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
  const term = screen.getByText(label, { selector: "dt" });
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

const freeform =
  'keep "bucketCount": 999 and "incompleteAvailInfo": true out of the card';

const statistics = {
  bucketCount: 2,
  totalObjectCount: 8,
  totalObjectBytes: 1000,
  dataAvail: 3000,
  metadataAvail: 4,
  incompleteAvailInfo: false,
  freeform,
};

function stubFetch(
  statisticsResponse: Response,
  health: Response = json(report),
  role: "admin" | "viewer" = "admin",
  writeBlocked = false,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return json({
        version: "20261010.1",
        listBucketsInfo: "unknown",
        listKeysInfo: "unknown",
      });
    }
    if (url.includes("/api/auth/status")) {
      return json(session(role, writeBlocked));
    }
    if (url === "/api/cluster/health") {
      return health;
    }
    if (url === "/api/cluster/statistics") {
      return statisticsResponse;
    }
    if (url === "/api/cluster/status") {
      return json({ nodes: [] });
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

const disconnected = "Available space may be lower because some nodes are disconnected.";

test("shows the status word and the seven cluster health counts to an admin", async () => {
  const fetchMock = stubFetch(json(statistics));
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
  expect(await screen.findByText("Buckets", { selector: "dt" })).toBeTruthy();
  expect(valueOf("Buckets")).toBe("2");
  expect(valueOf("Objects")).toBe("8");
  expect(valueOf("Object bytes")).toBe("1.00 KB");
  expect(valueOf("Data available")).toBe("3.00 KB");
  expect(valueOf("Metadata available")).toBe("4 B");
  expect(document.body.textContent).not.toContain(disconnected);
  expect(document.body.textContent).not.toContain("keep \"bucketCount\": 999");
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(fetchMock.mock.calls.some((entry) => entry[0] === "/api/cluster/health")).toBe(true);
  expect(fetchMock.mock.calls.some((entry) => entry[0] === "/api/cluster/statistics")).toBe(true);
});

test("shows the cluster health API message and leaves the version alert as the only alert", async () => {
  stubFetch(
    json({
      bucketCount: 2,
      totalObjectCount: 8,
      totalObjectBytes: 1000,
      dataAvail: 3000,
      metadataAvail: 4,
      freeform,
    }),
    json({ code: "garage_unavailable", message: "Garage admin API is not reachable" }, 502),
    "admin",
    true,
  );
  renderApp();
  const message = await screen.findByText("Garage admin API is not reachable");
  expect(message.tagName).toBe("P");
  expect(message.getAttribute("role")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("degraded")).toBeNull();
  expect(screen.queryByText("Known nodes")).toBeNull();
  expect(await screen.findByText("Buckets", { selector: "dt" })).toBeTruthy();
  expect(valueOf("Buckets")).toBe("2");
  expect(valueOf("Object bytes")).toBe("1.00 KB");
  expect(document.body.textContent).not.toContain(disconnected);
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage v2.3.0 or newer is required");
});

test("does not show cluster health to a viewer or request it", async () => {
  const fetchMock = stubFetch(json(statistics), json(report), "viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByText("degraded")).toBeNull();
  expect(screen.queryByText("Object bytes")).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/statistics")),
  ).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
});

test("shows a byte count past 2^53 from the response text and says a null field is not set", async () => {
  stubFetch(
    textResponse(
      '{"bucketCount":9007199254740993,"totalObjectCount":42,"totalObjectBytes":9007199254740993,"dataAvail":null,"metadataAvail":1000,"incompleteAvailInfo":null,"freeform":"keep \\"bucketCount\\": 999 out"}',
    ),
  );
  renderApp();
  expect(await screen.findByText("Buckets", { selector: "dt" })).toBeTruthy();
  expect(valueOf("Buckets")).toBe("9007199254740993");
  expect(valueOf("Objects")).toBe("42");
  expect(valueOf("Object bytes")).toBe("9.007199254740993 PB");
  expect(valueOf("Data available")).toBe("Data available is not set");
  expect(valueOf("Metadata available")).toBe("1.00 KB");
  expect(document.body.textContent).not.toContain("9007199254740992");
  expect(document.body.textContent).not.toContain("9.007199254740992 PB");
  expect(document.body.textContent).not.toContain(disconnected);
  expect(document.body.textContent).not.toContain('keep "bucketCount": 999');
  expect(valueOf("Status")).toBe("degraded");
});

test("shows the disconnected-node sentence only when incompleteAvailInfo is true", async () => {
  stubFetch(
    json({
      bucketCount: null,
      totalObjectCount: 7,
      totalObjectBytes: 10,
      dataAvail: 1000,
      incompleteAvailInfo: true,
      freeform,
    }),
  );
  renderApp();
  const note = await screen.findByText(disconnected);
  expect(note.tagName).toBe("P");
  expect(note.getAttribute("role")).toBeNull();
  expect(valueOf("Buckets")).toBe("Bucket count is not set");
  expect(valueOf("Objects")).toBe("7");
  expect(valueOf("Object bytes")).toBe("10 B");
  expect(valueOf("Data available")).toBe("1.00 KB");
  expect(valueOf("Metadata available")).toBe("Metadata available is not set");
  expect(document.body.textContent).not.toContain('keep "bucketCount": 999');
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("shows the statistics API message and still shows the health counts", async () => {
  stubFetch(
    json({ code: "garage_unavailable", message: "Cluster statistics are not reachable" }, 502),
  );
  renderApp();
  const message = await screen.findByText("Cluster statistics are not reachable");
  expect(message.tagName).toBe("P");
  expect(message.getAttribute("role")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("Buckets", { selector: "dt" })).toBeNull();
  expect(screen.queryByText("Object bytes")).toBeNull();
  expect(screen.queryByText("Object count is not set")).toBeNull();
  expect(valueOf("Status")).toBe("degraded");
  expect(valueOf("Known nodes")).toBe("5");
  expect(valueOf("Connected nodes")).toBe("4");
  expect(valueOf("Storage nodes")).toBe("3");
  expect(valueOf("Storage nodes up")).toBe("2");
  expect(valueOf("Partitions")).toBe("256");
  expect(valueOf("Partitions with quorum")).toBe("250");
  expect(valueOf("Partitions all ok")).toBe("240");
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});
