import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
  window.history.replaceState(null, "", "/");
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
  connectResponse?: () => Response | Promise<Response>,
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
  expect(up?.textContent).toContain("node-up");
  expect(up?.textContent).toContain("alpha");
  expect(up?.textContent).toContain("10.0.0.1:3901");
  expect(up?.textContent).toContain("v2.4.1");
  expect(up?.textContent).toContain("Up");
  expect(up?.querySelector("form")?.getAttribute("aria-label")).toBe("Node capacity");
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
  const message = await screen.findByText("There are no nodes. Connect the first node.");
  expect(message.tagName).toBe("P");
  expect(screen.getByRole("heading", { name: "Nodes" })).toBeTruthy();
  expect(screen.queryByText("Up")).toBeNull();
  expect(screen.queryByText("Down")).toBeNull();
});

test("shows Loading nodes and marks the nodes section busy on the first load", async () => {
  let release: (response: Response) => void = () => {};
  installFetch(
    "admin",
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  renderApp();
  const section = await screen.findByRole("region", { name: "Cluster nodes" });
  const loading = screen.getByLabelText("Loading nodes");
  expect(section.contains(loading)).toBe(true);
  expect(loading.getAttribute("role")).toBeNull();
  expect(screen.queryByText("Loading nodes")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  release(json({ layoutVersion: 3, nodes: [] }));
  const message = await screen.findByText("There are no nodes. Connect the first node.");
  expect(message.tagName).toBe("P");
  expect(screen.getByRole("region", { name: "Cluster nodes" }).contains(message)).toBe(true);
  expect(screen.queryByLabelText("Loading nodes")).toBeNull();
  expect(screen.queryByText("Loading nodes")).toBeNull();
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
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
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
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(nodeErrorLines()).toEqual([]);
  expect(screen.queryByRole("button", { name: "Retry nodes" })).toBeNull();
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
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe(
    "abcd@127.0.0.1:3901",
  );
  expect(message.getAttribute("role")).toBeNull();
  expect(message.textContent).toBe("Connect: Garage admin API is not reachable");
  expect(nodeErrorLines()).toEqual(["Connect: Garage admin API is not reachable"]);
  expect(screen.queryByText("garage_unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry nodes" })).toBeNull();
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

test("shows Connecting while connect is submitting, then Connected when no lines return", async () => {
  let release: (response: Response) => void = () => {};
  installFetch(
    "admin",
    () => textResponse(listed),
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  const input = screen.getByLabelText("Node address") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "abcd@127.0.0.1:3901" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  const pending = (await screen.findByRole("button", { name: "Connecting" })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Connecting");
  expect(input.value).toBe("abcd@127.0.0.1:3901");
  expect(screen.queryByText("Connected")).toBeNull();
  expect(screen.getByText("node-up")).toBeTruthy();
  release(json([]));
  const connected = await screen.findByText("Connected");
  expect(connected.tagName).toBe("P");
  expect(input.value).toBe("abcd@127.0.0.1:3901");
  const idle = screen.getByRole("button", { name: "Connect node" }) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Connect node");
  expect(screen.getByText("node-up")).toBeTruthy();
});

function nodeCardText(): string[] {
  return screen.queryAllByRole("listitem").map((item) => item.textContent ?? "");
}

function nodeErrorLines(): string[] {
  const section = screen.getByRole("region", { name: "Cluster nodes" });
  return [...section.children]
    .filter((node) => node.tagName === "P")
    .map((node) => node.textContent ?? "");
}

function callsFor(fetchMock: ReturnType<typeof installFetch>, url: string): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === url).length;
}

const recoveredNode = {
  nodes: [
    {
      id: "node-back",
      hostname: "beta",
      addr: "10.0.0.8:3901",
      garageVersion: "v2.4.1",
      isUp: true,
      draining: false,
    },
  ],
};

test("filters loaded nodes from the query string and keeps that choice in the address", async () => {
  window.history.replaceState(null, "", "/?nodes=APPLE&keep=1#stay");
  const fetchMock = installFetch("admin", () =>
    json({
      nodes: [
        {
          id: "n-b",
          hostname: "Apple",
          addr: "10.0.0.2:3901",
          garageVersion: "v2.4.1",
          isUp: true,
          draining: false,
        },
        {
          id: "n-a",
          hostname: "apple",
          addr: "10.0.0.3:3901",
          garageVersion: "v2.4.1",
          isUp: true,
          draining: false,
        },
        { id: "n-z", hostname: "", isUp: false, draining: false },
        { id: "n-c", isUp: false, draining: false },
        {
          id: "n-m",
          hostname: "mango",
          addr: "10.0.0.4:3901",
          garageVersion: "v2.4.1",
          isUp: true,
          draining: false,
        },
      ],
    }),
  );
  renderApp();
  expect(await screen.findByText("n-b")).toBeTruthy();
  expect(screen.getByText("n-a")).toBeTruthy();
  expect(screen.queryByText("n-z")).toBeNull();
  expect(screen.queryByText("n-c")).toBeNull();
  expect(screen.queryByText("n-m")).toBeNull();
  expect(nodeCardText()).toEqual([
    "n-bApple10.0.0.2:3901v2.4.1Up",
    "n-aapple10.0.0.3:3901v2.4.1Up",
  ]);
  expect((screen.getByLabelText("Filter nodes") as HTMLInputElement).value).toBe("APPLE");
  const sort = screen.getByLabelText("Sort nodes") as HTMLSelectElement;
  expect(sort.value).toBe("id");
  expect(Array.from(sort.options).map((option) => option.value)).toEqual(["id", "hostname"]);
  expect(Array.from(sort.options).map((option) => option.text)).toEqual(["Id", "Hostname"]);
  expect(screen.getByText("Default order is Id.").textContent).toBe("Default order is Id.");
  expect(screen.queryByText("Only loaded rows")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(screen.queryByText("Nodes are unavailable")).toBeNull();
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "Connect node" }).textContent).toBe("Connect node");
  expect(window.location.hash).toBe("#stay");
  expect(window.location.search).toContain("nodes=APPLE");
  expect(window.location.search).toContain("keep=1");
  const statusCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/cluster/status").length;
  expect(statusCalls()).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter nodes"), { target: { value: "" } });
  expect(nodeCardText()).toEqual([
    "n-bApple10.0.0.2:3901v2.4.1Up",
    "n-aapple10.0.0.3:3901v2.4.1Up",
    "n-zDown",
    "n-cDown",
    "n-mmango10.0.0.4:3901v2.4.1Up",
  ]);
  expect(window.location.search).toBe("?keep=1");
  expect(window.location.hash).toBe("#stay");
  expect(statusCalls()).toBe(1);

  fireEvent.change(screen.getByLabelText("Sort nodes"), { target: { value: "hostname" } });
  expect(nodeCardText()).toEqual([
    "n-cDown",
    "n-zDown",
    "n-aapple10.0.0.3:3901v2.4.1Up",
    "n-bApple10.0.0.2:3901v2.4.1Up",
    "n-mmango10.0.0.4:3901v2.4.1Up",
  ]);
  expect(new URLSearchParams(window.location.search).get("nodesSort")).toBe("hostname");
  expect(new URLSearchParams(window.location.search).has("nodes")).toBe(false);
  expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
  expect(window.location.hash).toBe("#stay");
  expect(statusCalls()).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter nodes"), { target: { value: "N-Z" } });
  expect(nodeCardText()).toEqual(["n-zDown"]);
  expect(screen.queryByText("n-c")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(window.location.search).toContain("nodes=N-Z");
  expect(window.location.search).toContain("nodesSort=hostname");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#stay");
  expect(statusCalls()).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?nodes=missing&keep=1#stay");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(nodeCardText()).toEqual([]);
  expect(screen.queryByText("n-a")).toBeNull();
  expect(screen.queryByText("n-b")).toBeNull();
  expect(screen.queryByText("n-c")).toBeNull();
  expect(screen.queryByText("n-z")).toBeNull();
  expect(screen.queryByText("n-m")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(screen.queryByText("Nodes are unavailable")).toBeNull();
  expect((screen.getByLabelText("Filter nodes") as HTMLInputElement).value).toBe("missing");
  expect((screen.getByLabelText("Sort nodes") as HTMLSelectElement).value).toBe("id");
  expect(window.location.hash).toBe("#stay");
  expect(statusCalls()).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?nodesSort=capacity&keep=1#stay");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect((screen.getByLabelText("Sort nodes") as HTMLSelectElement).value).toBe("id");
  expect(nodeCardText()).toEqual([
    "n-bApple10.0.0.2:3901v2.4.1Up",
    "n-aapple10.0.0.3:3901v2.4.1Up",
    "n-zDown",
    "n-cDown",
    "n-mmango10.0.0.4:3901v2.4.1Up",
  ]);
  expect(window.location.search).toContain("nodesSort=capacity");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#stay");
  expect(statusCalls()).toBe(1);
});

test("shows the node list code and retries only cluster status", async () => {
  let recover = false;
  const fetchMock = installFetch("admin", () => {
    if (!recover) {
      return json({ code: "node_list_failed", message: "Cannot list nodes" }, 500);
    }
    return json(recoveredNode);
  });
  renderApp();
  const message = await screen.findByText("Cannot list nodes");
  expect(message.tagName).toBe("P");
  expect(message.textContent).toBe("Cannot list nodes");
  expect(screen.getByText("node_list_failed").tagName).toBe("P");
  expect(screen.getByText("node_list_failed").getAttribute("role")).toBeNull();
  expect(nodeErrorLines()).toEqual(["Cannot list nodes", "node_list_failed"]);
  expect(screen.getByRole("button", { name: "Retry nodes" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Garage admin API is not reachable")).toBeNull();
  expect(screen.queryByLabelText("Loading nodes")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  const statusSeen = callsFor(fetchMock, "/api/cluster/status");
  const healthSeen = callsFor(fetchMock, "/api/cluster/health");
  const statisticsSeen = callsFor(fetchMock, "/api/cluster/statistics");
  const connectSeen = connectCalls(fetchMock).length;
  recover = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry nodes" }));
  expect(await screen.findByText("node-back")).toBeTruthy();
  expect(screen.getByText("beta")).toBeTruthy();
  expect(screen.getByText("10.0.0.8:3901")).toBeTruthy();
  expect(screen.getByText("Up")).toBeTruthy();
  expect(screen.queryByText("Cannot list nodes")).toBeNull();
  expect(screen.queryByText("node_list_failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry nodes" })).toBeNull();
  expect(nodeErrorLines()).toEqual([]);
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe(
    "abcd@127.0.0.1:3901",
  );
  expect((screen.getByLabelText("Filter nodes") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Sort nodes") as HTMLSelectElement).value).toBe("id");
  expect(screen.getByText("Default order is Id.").textContent).toBe("Default order is Id.");
  expect(callsFor(fetchMock, "/api/cluster/status")).toBe(statusSeen + 1);
  expect(callsFor(fetchMock, "/api/cluster/health")).toBe(healthSeen);
  expect(callsFor(fetchMock, "/api/cluster/statistics")).toBe(statisticsSeen);
  expect(connectCalls(fetchMock)).toHaveLength(connectSeen);
});

test("shows Retry nodes without a code line when the code is missing or empty", async () => {
  installFetch("admin", () => json({ message: "Cannot list nodes" }, 500));
  renderApp();
  const missing = await screen.findByText("Cannot list nodes");
  expect(missing.tagName).toBe("P");
  expect(missing.textContent).toBe("Cannot list nodes");
  expect(nodeErrorLines()).toEqual(["Cannot list nodes"]);
  expect(screen.getByRole("button", { name: "Retry nodes" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Loading nodes")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  cleanup();

  installFetch("admin", () => json({ code: "", message: "Cannot list nodes" }, 500));
  renderApp();
  const empty = await screen.findByText("Cannot list nodes");
  expect(empty.tagName).toBe("P");
  expect(empty.textContent).toBe("Cannot list nodes");
  expect(nodeErrorLines()).toEqual(["Cannot list nodes"]);
  expect(empty.nextElementSibling).toBe(screen.getByRole("button", { name: "Retry nodes" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("keeps Nodes are unavailable, shows Retry nodes, and adds no code line", async () => {
  let recover = false;
  const fetchMock = installFetch("admin", () => {
    if (!recover) {
      return json({ nodes: [{ isUp: true, draining: false }] });
    }
    return json(recoveredNode);
  });
  renderApp();
  const missing = await screen.findByText("Nodes are unavailable");
  expect(missing.tagName).toBe("P");
  expect(missing.textContent).toBe("Nodes are unavailable");
  expect(missing.getAttribute("role")).toBeNull();
  expect(nodeErrorLines()).toEqual(["Nodes are unavailable"]);
  expect(missing.nextElementSibling).toBe(screen.getByRole("button", { name: "Retry nodes" }));
  expect(screen.queryByText("Up")).toBeNull();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  const statusSeen = callsFor(fetchMock, "/api/cluster/status");
  const healthSeen = callsFor(fetchMock, "/api/cluster/health");
  const statisticsSeen = callsFor(fetchMock, "/api/cluster/statistics");
  recover = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry nodes" }));
  expect(await screen.findByText("node-back")).toBeTruthy();
  expect(screen.queryByText("Nodes are unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry nodes" })).toBeNull();
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe(
    "abcd@127.0.0.1:3901",
  );
  expect(connectCalls(fetchMock)).toHaveLength(0);
  expect(callsFor(fetchMock, "/api/cluster/status")).toBe(statusSeen + 1);
  expect(callsFor(fetchMock, "/api/cluster/health")).toBe(healthSeen);
  expect(callsFor(fetchMock, "/api/cluster/statistics")).toBe(statisticsSeen);
});

test("keeps the address and connect result when the node list fails and recovers", async () => {
  let statusHits = 0;
  const fetchMock = installFetch(
    "admin",
    () => {
      statusHits += 1;
      if (statusHits === 1) {
        return textResponse(listed);
      }
      if (statusHits === 2) {
        return json({ code: "status_failed", message: "Status broke" }, 503);
      }
      return json(recoveredNode);
    },
    () => json([{ success: false, error: "kept line" }]),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "  abcd@127.0.0.1:3901  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  expect(await screen.findByText("kept line")).toBeTruthy();
  const broke = await screen.findByText("Status broke");
  expect(broke.tagName).toBe("P");
  expect(broke.textContent).toBe("Status broke");
  expect(nodeErrorLines()).toEqual(["Status broke", "status_failed"]);
  expect(screen.getByText("status_failed").getAttribute("role")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry nodes" })).toBeTruthy();
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe(
    "  abcd@127.0.0.1:3901  ",
  );
  expect(screen.getByText("kept line")).toBeTruthy();
  expect(screen.queryByText("Connected")).toBeNull();
  expect(connectCalls(fetchMock)).toHaveLength(1);
  const statusSeen = callsFor(fetchMock, "/api/cluster/status");
  const healthSeen = callsFor(fetchMock, "/api/cluster/health");
  const statisticsSeen = callsFor(fetchMock, "/api/cluster/statistics");
  fireEvent.click(screen.getByRole("button", { name: "Retry nodes" }));
  expect(await screen.findByText("node-back")).toBeTruthy();
  expect(screen.getByText("kept line")).toBeTruthy();
  expect(screen.queryByText("Status broke")).toBeNull();
  expect(screen.queryByText("status_failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry nodes" })).toBeNull();
  expect(nodeErrorLines()).toEqual([]);
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe(
    "  abcd@127.0.0.1:3901  ",
  );
  expect(screen.getByText("beta")).toBeTruthy();
  expect(connectCalls(fetchMock)).toHaveLength(1);
  expect(callsFor(fetchMock, "/api/cluster/status")).toBe(statusSeen + 1);
  expect(callsFor(fetchMock, "/api/cluster/health")).toBe(healthSeen);
  expect(callsFor(fetchMock, "/api/cluster/statistics")).toBe(statisticsSeen);
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
});
