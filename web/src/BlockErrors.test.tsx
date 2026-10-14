import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { BlockErrors } from "./BlockErrors";
import { blockErrorsNodeId } from "./Nav";

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
      if (url === "/api/nodes/n1/blocks/aa11") {
        return new Response(
          JSON.stringify({
            blockHash: "aa11",
            refcount: 2,
            versions: [
              {
                versionId: "v1",
                refDeleted: false,
                versionDeleted: false,
                garbageCollected: true,
              },
            ],
          }),
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

function purgePosts(): { url: string; body: unknown; confirm: string | null }[] {
  return vi.mocked(fetch).mock.calls.flatMap(([input, init]) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST" || url !== "/api/nodes/n1/blocks/purge") {
      return [];
    }
    const raw = init?.body;
    return [
      {
        url,
        body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw,
        confirm: new Headers(init?.headers).get("x-confirm"),
      },
    ];
  });
}

test("clicking Purge aa11 posts that one hash after the operator types it", async () => {
  window.location.hash = "#block-errors/n1";
  stubAdminBlockErrors();
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Purge aa11" }));
  expect(purgePosts()).toEqual([]);
  fireEvent.change(screen.getByLabelText("Type aa11 to confirm"), {
    target: { value: "aa11" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => {
    expect(purgePosts()).toEqual([
      { url: "/api/nodes/n1/blocks/purge", body: ["aa11"], confirm: "yes" },
    ]);
  });
  expect(window.location.hash).toBe("#block-errors/n1");
});

function infoGets(): string[] {
  return vi.mocked(fetch).mock.calls.flatMap(([input, init]) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || url !== "/api/nodes/n1/blocks/aa11") {
      return [];
    }
    return [url];
  });
}

test("clicking Info aa11 shows version v1 for that node", async () => {
  window.location.hash = "#block-errors/n1";
  stubAdminBlockErrors();
  renderApp();
  const info = await screen.findByRole("button", { name: "Info aa11" });
  expect(infoGets()).toEqual([]);
  fireEvent.click(info);
  expect(await screen.findByText("v1")).toBeTruthy();
  expect(
    screen
      .getAllByRole("cell")
      .map((cell) => cell.textContent)
      .filter((text) => text === "v1" || text === "no" || text === "yes"),
  ).toEqual(["v1", "no", "no", "yes"]);
  expect(infoGets()).toEqual(["/api/nodes/n1/blocks/aa11"]);
  expect(window.location.hash).toBe("#block-errors/n1");
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const blockRow = {
  blockHash: "aa11",
  refcount: 2,
  errorCount: 3,
  lastTrySecsAgo: 4,
  nextTryInSecs: 5,
};

function renderBlockErrors() {
  window.location.hash = "#block-errors/n1";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BlockErrors />
    </QueryClientProvider>,
  );
  return client;
}

test("shows Loading block errors and marks the block errors section busy on the first load", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  renderBlockErrors();
  const section = screen.getByRole("region", { name: "Block errors" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading block errors").getAttribute("role")).toBeNull();
  expect(screen.queryByText("Loading block errors")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no block errors.")).toBeNull();
  expect(screen.queryByText("Refreshing block errors")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry all" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry aa11" })).toBeNull();
  release(json([blockRow]));
  expect(await screen.findByRole("button", { name: "Retry aa11" })).toBeTruthy();
  expect(screen.getByText("aa11")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Block errors" }).getAttribute("aria-busy")).toBe(
    "false",
  );
  expect(screen.queryByLabelText("Loading block errors")).toBeNull();
  expect(screen.queryByText("Loading block errors")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("says there are no block errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/block-errors");
      expect(init?.credentials).toBe("include");
      return json([]);
    }),
  );
  renderBlockErrors();
  expect((await screen.findByText("There are no block errors.")).textContent).toBe(
    "There are no block errors.",
  );
  expect(screen.getByText("There are no block errors.").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry aa11" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry all" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Purge aa11" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Info aa11" })).toBeNull();
  expect(screen.queryByLabelText("Loading block errors")).toBeNull();
  expect(screen.queryByText("Loading block errors")).toBeNull();
  expect(screen.getByRole("region", { name: "Block errors" }).getAttribute("aria-busy")).toBe(
    "false",
  );
});

test("shows the API code and requests the block error list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/block-errors");
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json({ code: "upstream_failed", message: "Garage returned an error" }, 502);
      }
      return json([blockRow]);
    }),
  );
  renderBlockErrors();
  expect((await screen.findByText("Garage returned an error")).textContent).toBe(
    "Garage returned an error",
  );
  expect(screen.getByText("upstream_failed").textContent).toBe("upstream_failed");
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no block errors.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry all" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry aa11" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Retry aa11" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry all" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Purge aa11" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Info aa11" })).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps one visible block error while a later fetch refreshes", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/block-errors");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json([blockRow]));
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderBlockErrors();
  expect(await screen.findByRole("button", { name: "Retry aa11" })).toBeTruthy();
  expect(screen.getByText("aa11")).toBeTruthy();
  expect(screen.queryByText("Refreshing block errors")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["nodes", "n1", "block-errors"] });
  expect(await screen.findByText("Refreshing block errors")).toBeTruthy();
  expect(screen.getByText("aa11")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry aa11" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry all" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Purge aa11" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Info aa11" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByLabelText("Loading block errors")).toBeNull();
  expect(screen.queryByText("Loading block errors")).toBeNull();
  expect(screen.getByRole("region", { name: "Block errors" }).getAttribute("aria-busy")).toBe(
    "false",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  releaseNext(json([blockRow]));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing block errors")).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Retry aa11" })).toBeTruthy();
  expect(calls).toBe(2);
});

test("says no node is selected", () => {
  window.location.hash = "#block-errors";
  expect(blockErrorsNodeId(window.location.hash)).toBeNull();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BlockErrors />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("heading", {name:"Select node"})).toBeTruthy();
});

 test("ordinary block-errors entry offers node navigation", async () => {
  window.location.hash = "#block-errors";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ layoutVersion: 1, nodes: [{id: "n1", hostname: "alpha", isUp: true, draining: false}] }), {status:200})));
  const client = new QueryClient({defaultOptions: {queries: {retry:false}}});
  render(<QueryClientProvider client={client}><BlockErrors /></QueryClientProvider>);
  const link = await screen.findByRole("link", {name: "alpha"});
  expect(link.getAttribute("href")).toBe("#block-errors/n1");
  fireEvent.click(link);
  expect(window.location.hash).toBe("#block-errors/n1");
 });

test("purge failure keeps the typed hash and success refreshes the visible errors", async () => {
  window.location.hash = "#block-errors/n1";
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/blocks/purge")) { attempts += 1; return new Response(JSON.stringify(attempts === 1 ? {message:"Purge rejected"} : {}), {status:attempts === 1 ? 409 : 200}); }
    return new Response(JSON.stringify(attempts === 2 ? [] : [{blockHash:"aa11",refcount:2,errorCount:3,lastTrySecsAgo:4,nextTryInSecs:5}]), {status:200});
  }));
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><BlockErrors /></QueryClientProvider>);
  await screen.findByText("aa11");
  fireEvent.click(screen.getByRole("button", {name:"Purge aa11"}));
  fireEvent.change(screen.getByLabelText("Type aa11 to confirm"), {target:{value:"aa11"}});
  fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  await screen.findByText("Purge rejected", {selector:"section > p"});
  expect(screen.getByLabelText("Type aa11 to confirm")).toHaveProperty("value","aa11");
  fireEvent.click(screen.getByRole("button", {name:"Confirm"}));
  await screen.findByText("There are no block errors.");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(attempts).toBe(2);
});
