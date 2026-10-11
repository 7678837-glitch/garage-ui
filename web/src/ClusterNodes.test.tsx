import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function installFetch(
  role: "admin" | "viewer",
  statusResponse: () => Response,
  connectResponse?: () => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return json({
        version: "20261010.1",
        listBucketsInfo: "unknown",
        listKeysInfo: "unknown",
      });
    }
    if (url.includes("/api/auth/status")) {
      return json(session(role));
    }
    if (url === "/api/cluster/status") {
      return statusResponse();
    }
    if (url === "/api/cluster/connect") {
      if (init?.method?.toUpperCase() !== "POST") {
        return new Response("no", { status: 405 });
      }
      return connectResponse ? connectResponse() : new Response("no", { status: 500 });
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

function connectCalls(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/cluster/connect");
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

test("shows the Garage banner instead of the cluster status message", async () => {
  installFetch("admin", () =>
    json({ code: "garage_unavailable", message: "Garage admin API is not reachable" }, 502),
  );
  renderApp();
  const banner = await screen.findByText("Garage admin API is not reachable");
  expect(banner.tagName).toBe("P");
  expect(banner.getAttribute("role")).toBe("alert");
  expect(banner.textContent).toBe("Garage admin API is not reachable");
  expect(screen.getAllByText("Garage admin API is not reachable")).toHaveLength(1);
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("There are no nodes.")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
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

test("does not send a connect request when the address is blank", async () => {
  const fetchMock = installFetch("admin", () => textResponse(listed));
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Connect node" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  fireEvent.change(screen.getByLabelText("Node address"), { target: { value: "   " } });
  const blank = screen.getByRole("button", { name: "Connect node" });
  expect((blank as HTMLButtonElement).disabled).toBe(true);
  const form = blank.closest("form");
  expect(form).toBeTruthy();
  fireEvent.submit(form as HTMLFormElement);
  expect(connectCalls(fetchMock)).toHaveLength(0);
  expect(screen.getByText("node-up")).toBeTruthy();
  expect(screen.getByText("alpha")).toBeTruthy();
  expect(screen.getByText("Down")).toBeTruthy();
});

test("posts one trimmed address as a json array and reloads nodes", async () => {
  let statusHits = 0;
  const fetchMock = installFetch(
    "admin",
    () => {
      statusHits += 1;
      if (statusHits === 1) {
        return textResponse(listed);
      }
      return json({
        nodes: [
          {
            id: "node-up",
            hostname: "alpha",
            addr: "10.0.0.1:3901",
            garageVersion: "v2.4.1",
            isUp: true,
            draining: false,
          },
          {
            id: "node-joined",
            hostname: "beta",
            addr: "127.0.0.1:3901",
            garageVersion: "v2.4.1",
            isUp: true,
            draining: false,
          },
        ],
      });
    },
    () => json([{ success: true }]),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  expect(screen.queryByText("node-joined")).toBeNull();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "  abcd@127.0.0.1:3901  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  expect(await screen.findByText("Connected")).toBeTruthy();
  expect(await screen.findByText("node-joined")).toBeTruthy();
  expect(screen.getByText("node-up")).toBeTruthy();
  expect(screen.getByText("alpha")).toBeTruthy();
  const posts = connectCalls(fetchMock);
  expect(posts).toHaveLength(1);
  const init = posts[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe('["abcd@127.0.0.1:3901"]');
  expect(new Headers(init?.headers).get("x-confirm")).toBeNull();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("shows each connect result in order when an item fails", async () => {
  installFetch("admin", () => textResponse(listed), () =>
    json([
      { success: true },
      { success: false, error: "no route to host" },
      { success: false, error: "" },
      { success: false },
    ]),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  expect(await screen.findByText("no route to host")).toBeTruthy();
  const texts = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(texts.slice(0, 4)).toEqual([
    "Connected",
    "no route to host",
    "Connection failed",
    "Connection failed",
  ]);
  expect(screen.getByText("node-up")).toBeTruthy();
  expect(screen.getByText("alpha")).toBeTruthy();
  expect(screen.getByText("Down")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

test("shows the connect API message in a paragraph and keeps the nodes", async () => {
  const fetchMock = installFetch("admin", () => textResponse(listed), () =>
    json({ code: "garage_unavailable", message: "Garage admin API is not reachable" }, 502),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  const statusCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/cluster/status").length;
  const before = statusCalls();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  const message = await screen.findByText("Connect: Garage admin API is not reachable");
  expect(message.tagName).toBe("P");
  expect(message.getAttribute("role")).toBeNull();
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByText("Connected")).toBeNull();
  expect(screen.getByText("node-up")).toBeTruthy();
  expect(screen.getByText("Down")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(statusCalls()).toBe(before);
});

test("wraps a 64-character node id, hostname, address, and connect result", async () => {
  const nodeId = "n".repeat(64);
  const hostname = "h".repeat(64);
  const address = "a".repeat(64);
  const connectResult = "r".repeat(64);
  installFetch(
    "admin",
    () =>
      json({
        nodes: [
          {
            id: nodeId,
            hostname,
            addr: address,
            garageVersion: "v2.4.1",
            isUp: true,
            draining: false,
          },
        ],
      }),
    () => json([{ success: false, error: connectResult }]),
  );
  renderApp();
  const id = await screen.findByText(nodeId);
  expect(id.classList.contains("break-all")).toBe(true);
  expect(id.closest("li")?.classList.contains("min-w-0")).toBe(true);
  expect(screen.getByText(hostname).classList.contains("break-all")).toBe(true);
  expect(screen.getByText(address).classList.contains("break-all")).toBe(true);
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  const line = await screen.findByText(connectResult);
  expect(line.classList.contains("break-all")).toBe(true);
  expect(line.closest("ul")?.classList.contains("min-w-0")).toBe(true);
  const items = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(items).toContain(connectResult);
  expect(items).toContain(`${nodeId}${hostname}${address}v2.4.1Up`);
});
