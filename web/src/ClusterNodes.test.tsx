import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

function render(ui: Parameters<typeof renderBase>[0]) {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  return renderBase(<Theme>{ui}</Theme>);
}

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

function chooseOption(label: string, name: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});

function renderApp() {
  if (window.location.hash === "") {
    window.location.hash = "#nodes";
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  document.querySelectorAll("details").forEach((item) => { item.open = true; });
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
  statusResponse: () => Response | Promise<Response>,
  connectResponse?: () => Response | Promise<Response>,
  previewResponse?: () => Response | Promise<Response>,
  historyResponse?: () => Response | Promise<Response>,
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
    if (url === "/api/layout/preview") {
      return previewResponse ? previewResponse() : new Response("no", { status: 500 });
    }
    if (url === "/api/layout/history") {
      return historyResponse ? historyResponse() : new Response("no", { status: 500 });
    }
    if (url === "/api/nodes/n1/metadata-snapshot" && init?.method?.toUpperCase() === "POST") {
      return new Response("", { status: 200 });
    }
    if (url === "/api/nodes/*/metadata-snapshot" && init?.method?.toUpperCase() === "POST") {
      return new Response("", { status: 200 });
    }
    if (url === "/api/layout/skip-dead-nodes") return json({});
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
  const up = screen.getByText("node-up").closest("tr");
  const down = screen.getByText("node-down").closest("tr");
  expect(up?.textContent).toContain("node-up");
  expect(up?.textContent).toContain("alpha");
  expect(screen.getByRole("link", { name: "alpha · Node node-up" }).textContent).toBe("alpha");
  expect(up?.textContent).toContain("10.0.0.1:3901");
  expect(up?.textContent).toContain("v2.4.1");
  expect(up?.textContent).toContain("Up");
  expect(up?.querySelector("form")?.getAttribute("aria-label")).toBe("Node capacity");
  expect(down?.textContent).toContain("node-down");
  expect(down?.textContent).toContain("DownDraining");
  const page = document.body.textContent ?? "";
  expect(page).toContain("9007199254740993");
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
  expect(loading.getAttribute("role")).toBe("status");
  expect(screen.getByText("Loading nodes")).toBeTruthy();
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
  const account = await screen.findByRole("button", { name: "Bea · viewer" });
  fireEvent.click(account);
  expect(await screen.findByText("ok · test")).toBeTruthy();
  fireEvent.click(account);
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
  expect(message.closest("details")).toBeTruthy();
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
  expect(id.classList.contains("ui-identifier")).toBe(true);
  expect(id.closest("tr")).toBeTruthy();
  expect(screen.getByText(hostname).getAttribute("href")).toContain(encodeURIComponent(nodeId));
  expect(screen.getByText(address).classList.contains("ui-identifier")).toBe(true);
  fireEvent.change(screen.getByLabelText("Node address"), {
    target: { value: "abcd@127.0.0.1:3901" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect node" }));
  const line = await screen.findByText(connectResult);
  expect(line.classList.contains("break-all")).toBe(true);
  expect(line.closest("ul")?.classList.contains("min-w-0")).toBe(true);
  const items = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(items).toContain(connectResult);
  expect(nodeCardText()).toContain(nodeCard(nodeId, `${nodeId}${hostname}${address}v2.4.1Up`));
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

function nodeCard(id: string, body: string): string {
  void id; return body;
}

function nodeCardText(): string[] {
  return [...document.querySelectorAll("table tbody tr")].map(item => {
    const identity = item.querySelector('[data-kind="identity"] .ui-data-value');
    const id = identity?.querySelector("code, p.ui-identifier")?.textContent ?? "";
    const hostname = identity?.querySelector("a")?.textContent ?? "";
    const metadata = [...(identity?.querySelectorAll("p.ui-muted") ?? [])].map(field => field.textContent).join("");
    const status = item.querySelector('[data-kind="metadata"] .ui-data-value')?.textContent ?? "";
    return id + (hostname === "—" ? "" : hostname) + metadata + status;
  });
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
  window.history.replaceState(null, "", "/?nodes=APPLE&keep=1#nodes/stay");
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
    nodeCard("n-b", "n-bApple10.0.0.2:3901v2.4.1Up"),
    nodeCard("n-a", "n-aapple10.0.0.3:3901v2.4.1Up"),
  ]);
  expect((screen.getByLabelText("Filter nodes") as HTMLInputElement).value).toBe("APPLE");
  const sort = screen.getByRole("combobox", { name: "Sort nodes" });
  expect(sort.textContent).toBe("Id");
  fireEvent.keyDown(sort, { key: "ArrowDown" });
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Id", "Hostname"]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  expect(screen.getByText("Default order is Id.").textContent).toBe("Default order is Id.");
  expect(screen.queryByText("Only loaded rows")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(screen.queryByText("Nodes are unavailable")).toBeNull();
  expect((screen.getByLabelText("Node address") as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "Connect node" }).textContent).toBe("Connect node");
  expect(window.location.hash).toBe("#nodes/stay");
  expect(window.location.search).toContain("nodes=APPLE");
  expect(window.location.search).toContain("keep=1");
  const statusCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/cluster/status").length;
  expect(statusCalls()).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter nodes"), { target: { value: "" } });
  expect(nodeCardText()).toEqual([
    nodeCard("n-b", "n-bApple10.0.0.2:3901v2.4.1Up"),
    nodeCard("n-a", "n-aapple10.0.0.3:3901v2.4.1Up"),
    nodeCard("n-z", "n-zDown"),
    nodeCard("n-c", "n-cDown"),
    nodeCard("n-m", "n-mmango10.0.0.4:3901v2.4.1Up"),
  ]);
  expect(window.location.search).toBe("?keep=1");
  expect(window.location.hash).toBe("#nodes/stay");
  expect(statusCalls()).toBe(1);

  chooseOption("Sort nodes", "Hostname");
  expect(nodeCardText()).toEqual([
    nodeCard("n-c", "n-cDown"),
    nodeCard("n-z", "n-zDown"),
    nodeCard("n-a", "n-aapple10.0.0.3:3901v2.4.1Up"),
    nodeCard("n-b", "n-bApple10.0.0.2:3901v2.4.1Up"),
    nodeCard("n-m", "n-mmango10.0.0.4:3901v2.4.1Up"),
  ]);
  expect(new URLSearchParams(window.location.search).get("nodesSort")).toBe("hostname");
  expect(new URLSearchParams(window.location.search).has("nodes")).toBe(false);
  expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
  expect(window.location.hash).toBe("#nodes/stay");
  expect(statusCalls()).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter nodes"), { target: { value: "N-Z" } });
  expect(nodeCardText()).toEqual([nodeCard("n-z", "n-zDown")]);
  expect(screen.queryByText("n-c")).toBeNull();
  expect(screen.queryByText("There are no nodes. Connect the first node.")).toBeNull();
  expect(window.location.search).toContain("nodes=N-Z");
  expect(window.location.search).toContain("nodesSort=hostname");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#nodes/stay");
  expect(statusCalls()).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?nodes=missing&keep=1#nodes/stay");
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
  expect(screen.getByRole("combobox", { name: "Sort nodes" }).textContent).toBe("Id");
  expect(window.location.hash).toBe("#nodes/stay");
  expect(statusCalls()).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?nodesSort=capacity&keep=1#nodes/stay");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByRole("combobox", { name: "Sort nodes" }).textContent).toBe("Id");
  expect(nodeCardText()).toEqual([
    nodeCard("n-b", "n-bApple10.0.0.2:3901v2.4.1Up"),
    nodeCard("n-a", "n-aapple10.0.0.3:3901v2.4.1Up"),
    nodeCard("n-z", "n-zDown"),
    nodeCard("n-c", "n-cDown"),
    nodeCard("n-m", "n-mmango10.0.0.4:3901v2.4.1Up"),
  ]);
  expect(window.location.search).toContain("nodesSort=capacity");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#nodes/stay");
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
  expect(screen.getByRole("combobox", { name: "Sort nodes" }).textContent).toBe("Id");
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

test("purge asks for the block hash before it sends", async () => {
  const fetchMock = installFetch("admin", () =>
    json({
      nodes: [
        {
          id: "n1",
          hostname: "alpha",
          isUp: true,
          draining: false,
        },
      ],
    }),
  );
  renderApp();
  expect(await screen.findByText("n1")).toBeTruthy();
  const field = screen.getByLabelText("Block hash for n1") as HTMLInputElement;
  const purge = screen.getByRole("button", { name: "Purge blocks on n1" });
  const purgePosts = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/nodes/n1/blocks/purge");

  fireEvent.click(purge);
  expect(screen.queryByRole("heading", { name: "Confirm abc" })).toBeNull();
  expect(screen.queryByText("Object data will be lost.")).toBeNull();
  expect(purgePosts()).toHaveLength(0);

  fireEvent.change(field, { target: { value: "  abc  " } });
  fireEvent.click(purge);
  expect(screen.getByRole("heading", { name: "Confirm abc" })).toBeTruthy();
  expect(screen.getByText("Object data will be lost.").tagName).toBe("P");
  expect(screen.getAllByText("n1")).toHaveLength(2);
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  fireEvent.change(screen.getByLabelText("Type abc to confirm"), { target: { value: "nope" } });
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(purgePosts()).toHaveLength(0);

  fireEvent.change(screen.getByLabelText("Type abc to confirm"), { target: { value: "abc" } });
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(screen.getByRole("heading", { name: "Confirm abc" })).toBeTruthy();
  await act(async () => {});
  expect(purgePosts()).toHaveLength(1);
  const init = purgePosts()[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("x-confirm")).toBe("yes");
  expect(init?.body).toBe('["abc"]');

  fireEvent.click(purge);
  expect(screen.getByRole("heading", { name: "Confirm abc" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("heading", { name: "Confirm abc" })).toBeNull();
  expect(purgePosts()).toHaveLength(1);
});

test("apply stays disabled until preview succeeds", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const staged = "staged layout is hidden";
  const stale = "layout version changed";
  const responses = [
    json({ message: staged }),
    json({ message: stale }, 400),
    new Response("not-json", { status: 500 }),
  ];
  const fetchMock = installFetch("admin", () => textResponse(listed), undefined, () => {
    const next = responses.shift();
    return next ?? new Response("no", { status: 500 });
  });
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();

  const previewPosts = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/layout/preview");
  const applyPosts = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/layout/apply");
  const applyButton = () =>
    screen.getByRole("button", { name: "Apply layout" }) as HTMLButtonElement;

  const preview = screen.getByRole("button", { name: "Preview layout" });
  expect(preview.closest("tr")).toBeNull();
  expect(preview.getAttribute("type")).toBe("button");
  expect(applyButton().closest("tr")).toBeNull();
  expect(applyButton().getAttribute("type")).toBe("button");
  expect(applyButton().disabled).toBe(true);
  expect(previewPosts()).toHaveLength(0);
  expect(applyPosts()).toHaveLength(0);
  expect(screen.queryByText(staged)).toBeNull();

  fireEvent.click(applyButton());
  await act(async () => {});
  expect(applyPosts()).toHaveLength(0);
  expect(previewPosts()).toHaveLength(0);

  await act(async () => {
    fireEvent.click(preview);
  });
  expect(previewPosts()).toHaveLength(1);
  const init = previewPosts()[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(init?.body ?? null).toBeNull();
  expect(init?.credentials).toBe("include");
  expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-token");
  expect(applyButton().disabled).toBe(false);
  expect(screen.queryByText(staged)).toBeNull();
  expect(applyPosts()).toHaveLength(0);

  fireEvent.click(applyButton());
  await act(async () => {});
  expect(applyPosts()).toHaveLength(0);
  expect(previewPosts()).toHaveLength(1);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/layout/apply"))).toBe(
    false,
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    fireEvent.click(preview);
  });
  expect(previewPosts()).toHaveLength(2);
  expect(applyButton().disabled).toBe(true);
  expect(screen.getByText(stale)).toBeTruthy();
  expect(screen.queryByText(staged)).toBeNull();
  expect(applyPosts()).toHaveLength(0);

  await act(async () => {
    fireEvent.click(preview);
  });
  expect(previewPosts()).toHaveLength(3);
  expect(applyButton().disabled).toBe(true);
  expect(screen.getByText("Layout preview failed")).toBeTruthy();
  expect(screen.queryByText(stale)).toBeNull();
  expect(screen.queryByText(staged)).toBeNull();
  expect(applyPosts()).toHaveLength(0);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/layout/apply"))).toBe(
    false,
  );
});

function paragraphText(item: Element | null): string[] {
  return Array.from(item?.querySelectorAll("p") ?? []).map((node) => node.textContent ?? "");
}

test("history shows each version and its sync status", async () => {
  const versions = [
    { version: 3, status: "Current", storageNodes: 2, gatewayNodes: 1 },
    { version: 2, status: "Draining", storageNodes: 2, gatewayNodes: 0 },
  ];
  const responses = [
    json({
      versions,
      updateTrackers: { n1: { ack: 3, sync: 3, syncAck: 2 } },
    }),
    json({ versions, updateTrackers: null }),
    new Response("not-json", { status: 500 }),
  ];
  const fetchMock = installFetch(
    "admin",
    () =>
      json({
        nodes: [{ id: "node-up", hostname: "alpha", isUp: true, draining: false }],
      }),
    undefined,
    undefined,
    () => {
      const next = responses.shift();
      return next ?? new Response("no", { status: 500 });
    },
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();

  const historyCalls = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/layout/history");
  const historyButton = screen.getByRole("button", { name: "Layout history" });
  expect(historyButton.closest("tr")).toBeNull();
  expect(screen.queryAllByRole("listitem").every((item) => !item.contains(historyButton))).toBe(
    true,
  );
  expect(historyCalls()).toHaveLength(0);
  expect(screen.queryByText("Current")).toBeNull();
  expect(screen.queryByText("n1")).toBeNull();

  await act(async () => {
    fireEvent.click(historyButton);
  });
  expect(historyCalls()).toHaveLength(1);
  const init = historyCalls()[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("GET");
  expect(init?.credentials).toBe("include");
  expect(init?.body ?? null).toBeNull();
  expect(paragraphText(screen.getByText("Current").closest("li"))).toEqual(["3", "Current"]);
  expect(paragraphText(screen.getByText("Draining").closest("li"))).toEqual(["2", "Draining"]);
  expect(paragraphText(screen.getByText("n1").closest("li"))).toEqual(["n1", "3", "3", "2"]);

  await act(async () => {
    fireEvent.click(historyButton);
  });
  expect(historyCalls()).toHaveLength(2);
  expect(paragraphText(screen.getByText("Current").closest("li"))).toEqual(["3", "Current"]);
  expect(paragraphText(screen.getByText("Draining").closest("li"))).toEqual(["2", "Draining"]);
  expect(screen.queryByText("n1")).toBeNull();

  await act(async () => {
    fireEvent.click(historyButton);
  });
  expect(historyCalls()).toHaveLength(3);
  expect(screen.getByText("Layout history failed").tagName).toBe("P");
  expect(screen.queryByText("Current")).toBeNull();
  expect(screen.queryByText("Draining")).toBeNull();
  expect(screen.queryByText("n1")).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/layout/apply"))).toBe(
    false,
  );
});

test("snapshot metadata on n1 shows the notice", async () => {
  window.location.hash = "#node/n1/information";
  const fetchMock = installFetch("admin", () =>
    json({ nodes: [{ id: "n1", isUp: true, draining: false }] }),
  );
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Snapshot metadata" }));
  expect(await screen.findByText("Metadata snapshot started")).toBeTruthy();
  expect(window.location.hash).toBe("#node/n1/information");
  expect(screen.queryByRole("dialog")).toBeNull();
  const posts = fetchMock.mock.calls.filter(
    (call) => String(call[0]) === "/api/nodes/n1/metadata-snapshot",
  );
  expect(posts).toHaveLength(1);
  const init = posts[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(init?.body ?? null).toBeNull();
  expect(new Headers(init?.headers).get("x-confirm")).toBeNull();
});

test("snapshot every node shows the notice", async () => {
  window.location.hash = "#nodes";
  const fetchMock = installFetch("admin", () =>
    json({ nodes: [{ id: "n1", isUp: true, draining: false }] }),
  );
  renderApp();
  expect(await screen.findByText("n1")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Snapshot every node" }));
  expect(await screen.findByText("Metadata snapshot started")).toBeTruthy();
  expect(window.location.hash).toBe("#nodes");
  expect(screen.queryByRole("dialog")).toBeNull();
  const posts = fetchMock.mock.calls.filter(
    (call) => String(call[0]) === "/api/nodes/*/metadata-snapshot",
  );
  expect(posts).toHaveLength(1);
  const init = posts[0]?.[1] as RequestInit | undefined;
  expect(init?.method).toBe("POST");
  expect(init?.body ?? null).toBeNull();
  expect(new Headers(init?.headers).get("x-confirm")).toBeNull();
});

test("skip dead nodes passes the current version and confirms when data may be lost", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const current = "9007199254740993";
  const fetchMock = installFetch("admin", () =>
    textResponse(
      `{"layoutVersion":${current},"nodes":[{"id":"node-up","hostname":"alpha","isUp":true,"draining":false}]}`,
    ),
  );
  renderApp();
  expect(await screen.findByText("node-up")).toBeTruthy();

  const skipPosts = () =>
    fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/layout/skip-dead-nodes");
  const allow = screen.getByRole("checkbox", { name: "Allow missing data" }) as HTMLInputElement;
  const skip = screen.getByRole("button", { name: "Skip dead nodes" });
  expect(allow.getAttribute("aria-checked")).toBe("false");
  expect(skipPosts()).toHaveLength(0);
  expect(screen.queryByText("Data may be lost.")).toBeNull();

  async function confirmCurrent() {
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(`Type ${current} to confirm`), {
      target: { value: current },
    });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("button", {name:"Working"})).toBeNull());
  }

  fireEvent.click(skip);
  expect(screen.queryByText("Data may be lost.")).toBeNull();
  expect(screen.getByRole("heading", { name: `Confirm ${current}` })).toBeTruthy();
  await confirmCurrent();
  expect(screen.queryByText("Data may be lost.")).toBeNull();
  expect(skipPosts()).toHaveLength(1);
  const kept = skipPosts()[0]?.[1] as RequestInit | undefined;
  expect(kept?.method).toBe("POST");
  expect(kept?.body).toBe(`{"allowMissingData":false,"version":${current}}`);
  expect(new Headers(kept?.headers).get("x-confirm")).toBe("yes");

  fireEvent.click(allow);
  expect(allow.getAttribute("aria-checked")).toBe("true");
  expect(skipPosts()).toHaveLength(1);
  fireEvent.click(skip);
  expect(screen.queryByText("Data may be lost.")).toBeNull();
  await confirmCurrent();
  expect(screen.getByText("Data may be lost.").tagName).toBe("P");
  expect(skipPosts()).toHaveLength(1);
  await confirmCurrent();
  expect(skipPosts()).toHaveLength(2);
  const lost = skipPosts()[1]?.[1] as RequestInit | undefined;
  expect(lost?.method).toBe("POST");
  expect(lost?.body).toBe(`{"allowMissingData":true,"version":${current}}`);
  expect(lost?.body).not.toContain('"version":9007199254740994');
  expect(new Headers(lost?.headers).get("x-confirm")).toBe("yes");
});

test("failed apply keeps confirmation and successful retry refreshes version for skip", async () => {
  let version = 1;
  let attempts = 0;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/status") return json(session("admin"));
    if (url === "/api/cluster/status") return json({layoutVersion: version, nodes: [{id:"n1",isUp:true,draining:false}]});
    if (url === "/api/layout/preview") return json({});
    if (url === "/api/layout/history") return json({versions:[{version,status:"Current"}],updateTrackers:[]});
    if (url === "/api/layout/apply") {
      attempts += 1;
      if (attempts === 1) return json({message:"Apply rejected"}, 409);
      version = 2;
      return json({});
    }
    if (url === "/api/layout/skip-dead-nodes") { writes.push(String(init?.body)); return json({}); }
    return json({status:"ok",version:"test"});
  }));
  renderApp();
  await screen.findByText("n1");
  fireEvent.click(screen.getByRole("button", {name:"Preview layout"}));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", {name:"Apply layout"}));
  fireEvent.change(screen.getByLabelText("Type 2 to confirm"), {target:{value:"2"}});
  fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  expect(await screen.findByText("Apply rejected", {selector:"[role=alert]"})).toBeTruthy();
  expect(screen.getByLabelText("Type 2 to confirm")).toHaveProperty("value", "2");
  fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  await screen.findByText("Saved");
  fireEvent.click(screen.getByRole("button", {name:"Skip dead nodes"}));
  fireEvent.change(screen.getByLabelText("Type 2 to confirm"), {target:{value:"2"}});
  fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  await act(async () => {});
  expect(writes).toEqual(['{"allowMissingData":false,"version":2}']);
});

test.each(["stage", "revert", "skip", "snapshot", "purge"] as const)("%s reports failure, preserves retry, and refreshes node context", async (operation) => {
  let version = 1;
  let attempts = 0;
  const path = {stage:"/api/layout/stage",revert:"/api/layout/revert",skip:"/api/layout/skip-dead-nodes",snapshot:"/api/nodes/*/metadata-snapshot",purge:"/api/nodes/n1/blocks/purge"}[operation];
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url === "/api/auth/status") return json(session("admin"));
    if (url === "/api/cluster/status") return json({layoutVersion:version,nodes:[{id:"n1",hostname:"alpha",isUp:true,draining:false,role:{capacity:version * 1000000000000}}]});
    if (url === "/api/layout/preview") return json({});
    if (url === "/api/layout/history") return json({versions:[{version,status:`Current ${version}`}],updateTrackers:{}});
    if (url === path) { attempts += 1; if (attempts === 1) return json({message:`${operation} rejected`},409); version = 2; return json({}); }
    return json({status:"ok",version:"test"});
  }));
  renderApp();
  await screen.findByText("n1");
  document.querySelectorAll("details").forEach(item => { item.open = true; });
  const button = () => screen.getByRole("button", {name:{stage:"Save",revert:"Revert staged changes",skip:"Skip dead nodes",snapshot:"Snapshot every node",purge:"Purge blocks on n1"}[operation]});
  if (operation === "stage") fireEvent.change(screen.getByLabelText("Capacity"), {target:{value:"3"}});
  if (operation === "purge") fireEvent.change(screen.getByLabelText("Block hash for n1"), {target:{value:"aa11"}});
  fireEvent.click(button());
  if (operation === "skip" || operation === "purge") {
    fireEvent.change(screen.getByLabelText(`Type ${operation === "skip" ? "1" : "aa11"} to confirm`), {target:{value:operation === "skip" ? "1" : "aa11"}});
    fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  }
  await screen.findByText(`${operation} rejected`, {selector:"[role=alert]"});
  if (operation === "stage") expect(screen.getByLabelText("Capacity")).toHaveProperty("value","3");
  if (operation === "purge") expect(screen.getByLabelText("Type aa11 to confirm")).toHaveProperty("value","aa11");
  if (operation === "skip" || operation === "purge") fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  else fireEvent.click(button());
  await screen.findByText(operation === "snapshot" ? "Metadata snapshot started" : "Saved");
  expect(attempts).toBe(2);
  expect(await screen.findByText("2000000000000 B", {selector:"code"})).toBeTruthy();
  if (operation === "stage" || operation === "skip" || operation === "revert") {
    expect(screen.getByText("Current 2")).toBeTruthy();
    expect((screen.getByRole("button", {name:"Apply layout"}) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.filter(url => url === "/api/layout/preview")).toHaveLength(1);
  }
});


test("node detail has one hostname heading and exposes exact capacity and full identity", async () => {
  const id = "n".repeat(64);
  window.location.hash = `#node/${id}/information`;
  installFetch("admin", () => textResponse(`{"nodes":[{"id":"${id}","hostname":"storage-alpha","addr":"10.0.0.1:3901","garageVersion":"v2.4.1","isUp":true,"draining":false,"role":{"capacity":9007199254740993}}]}`));
  renderApp();
  expect(await screen.findByRole("heading", { name: "storage-alpha" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  const exact = screen.getByText("9007199254740993 B", { selector: "code" });
  expect(exact.closest("details")?.querySelector("summary")?.textContent).toBe("Exact bytes");
  expect(screen.getByText(id, { selector: "code" }).closest("details")).toBeTruthy();
  expect(screen.getByText("10.0.0.1:3901").closest("dd")).toBeTruthy();
});

test("node records retain capacity editing and maintenance in the same semantic row", async () => {
  installFetch("admin", () => textResponse(listed));
  renderApp();
  const identity = await screen.findByText("node-up");
  const row = identity.closest("tr");
  expect(row?.closest(".ui-table-records") !== null).toBe(true);
  const disclosure = row?.querySelector('[data-kind="actions"] details') as HTMLDetailsElement;
  expect(disclosure.querySelector("summary")?.textContent).toBe("Maintenance");
  disclosure.open = true;
  expect(row?.querySelector('form[aria-label="Node capacity"]')).toBeTruthy();
  expect(row?.querySelector('[aria-label="Purge blocks on node-up"]')).toBeTruthy();
  expect(row?.querySelector('code')?.textContent).toBe("9007199254740993 B");
});
