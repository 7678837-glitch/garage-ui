import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { workersNodeId } from "./Nav";
import { Workers } from "./Workers";

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

test("an admin on #workers/n1 starts a tables repair after typing n1", async () => {
  window.location.hash = "#workers/n1";
  const repairs: { url: string; method: string; body: string; confirm: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url === "/api/nodes/n1/repair") {
        repairs.push({
          url,
          method: (init?.method ?? "GET").toUpperCase(),
          body: typeof init?.body === "string" ? init.body : "",
          confirm: new Headers(init?.headers).get("x-confirm"),
        });
        return new Response("null", { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("block_resync")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Repair type" }), {
    target: { value: "tables" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start repair" }));
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(repairs).toEqual([]);
  fireEvent.change(screen.getByLabelText("Type n1 to confirm"), { target: { value: "n1" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(repairs).toEqual([
      {
        url: "/api/nodes/n1/repair",
        method: "POST",
        body: JSON.stringify({ repairType: "tables" }),
        confirm: "yes",
      },
    ]);
  });
  expect(window.location.hash).toBe("#workers/n1");
});

test("an admin on #workers/n1 posts scrub start, pause, resume, and cancel after typing n1", async () => {
  window.location.hash = "#workers/n1";
  const repairs: { url: string; method: string; body: string; confirm: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url === "/api/nodes/n1/repair") {
        repairs.push({
          url,
          method: (init?.method ?? "GET").toUpperCase(),
          body: typeof init?.body === "string" ? init.body : "",
          confirm: new Headers(init?.headers).get("x-confirm"),
        });
        return new Response("null", { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("block_resync")).toBeTruthy();
  const commands = ["start", "pause", "resume", "cancel"] as const;
  for (const command of commands) {
    fireEvent.change(screen.getByRole("combobox", { name: "Repair type" }), {
      target: { value: `scrub:${command}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start repair" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(repairs).toHaveLength(commands.indexOf(command));
    fireEvent.change(screen.getByLabelText("Type n1 to confirm"), { target: { value: "n1" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(repairs).toEqual(
        commands.slice(0, commands.indexOf(command) + 1).map((sent) => ({
          url: "/api/nodes/n1/repair",
          method: "POST",
          body: JSON.stringify({ repairType: { scrub: sent } }),
          confirm: "yes",
        })),
      );
    });
  }
  expect(window.location.hash).toBe("#workers/n1");
});

test("clicking Details 7 shows rpc timeout", async () => {
  window.location.hash = "#workers/n1";
  const details: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url.includes("/api/nodes/n1/workers/7")) {
        details.push({ url, method: (init?.method ?? "GET").toUpperCase() });
        return new Response(
          JSON.stringify({
            id: 7,
            name: "block_resync",
            state: "busy",
            errors: 1,
            progress: "1/4",
            lastError: { message: "rpc timeout", secsAgo: 4 },
          }),
          { status: 200 },
        );
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
  renderApp();
  expect(await screen.findByText("block_resync")).toBeTruthy();
  expect(details).toEqual([]);
  expect(screen.queryByText("rpc timeout")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Details 7/ }));
  expect(await screen.findByText("rpc timeout")).toBeTruthy();
  expect(details).toEqual([{ url: "/api/nodes/n1/workers/7", method: "GET" }]);
  expect(window.location.hash).toBe("#workers/n1");
});

test("saving scrub_tranquility sends the new value after typing its name", async () => {
  window.location.hash = "#workers/n1";
  const writes: { url: string; method: string; body: string; confirm: string | null }[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
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
      if (url === "/api/nodes/n1/worker-variables" && method === "PUT") {
        writes.push({
          url,
          method,
          body: typeof init?.body === "string" ? init.body : "",
          confirm: new Headers(init?.headers).get("x-confirm"),
        });
        return new Response(
          JSON.stringify({ variable: "scrub_tranquility", value: "3" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/nodes/n1/worker-variables")) {
        reads.push(url);
        return new Response(JSON.stringify({ scrub_tranquility: "3" }), { status: 200 });
      }
      if (url.includes("/api/nodes/n1/workers/7")) {
        return new Response("no", { status: 500 });
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
  renderApp();
  expect(await screen.findByText("block_resync")).toBeTruthy();
  expect(screen.getAllByText("3").map((node) => node.textContent)).toEqual(["3"]);
  fireEvent.change(screen.getByLabelText("Variable"), { target: { value: "scrub_tranquility" } });
  fireEvent.change(screen.getByLabelText("Value"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save variable" }));
  expect(screen.getByText("This changes a worker variable on the node.")).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(writes).toEqual([]);
  expect(reads).toEqual([]);
  fireEvent.change(screen.getByLabelText("Type scrub_tranquility to confirm"), {
    target: { value: "scrub" },
  });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Type scrub_tranquility to confirm"), {
    target: { value: "scrub_tranquility" },
  });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(await screen.findByText("Variable scrub_tranquility is 3")).toBeTruthy();
  expect(writes).toEqual([
    {
      url: "/api/nodes/n1/worker-variables",
      method: "PUT",
      body: JSON.stringify({ variable: "scrub_tranquility", value: "3" }),
      confirm: "yes",
    },
  ]);
  expect(reads).toEqual(["/api/nodes/n1/worker-variables?variable=scrub_tranquility"]);
  expect(screen.getAllByText("3").map((node) => node.textContent)).toEqual(["3"]);
  expect(window.location.hash).toBe("#workers/n1");
});

test("an admin on #workers/* sees both nodes", async () => {
  window.location.hash = "#workers/*";
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
      if (url.includes("/api/nodes/*/workers")) {
        return new Response(
          JSON.stringify({
            n1: [
              {
                id: 7,
                name: "block_resync",
                state: "busy",
                errors: 1,
                progress: "1/4",
              },
            ],
            n2: [
              {
                id: 8,
                name: "block_rc",
                state: "done",
                errors: 0,
                progress: "",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("n1")).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.getByText("n2")).toBeTruthy();
  expect(screen.getByText("block_rc")).toBeTruthy();
  expect(window.location.hash).toBe("#workers/*");
});

test("starting repair on #workers/* posts tables after typing the star", async () => {
  window.location.hash = "#workers/*";
  const repairs: { url: string; method: string; body: string; confirm: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
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
      if (url === "/api/nodes/%2A/repair" || url === "/api/nodes/*/repair") {
        repairs.push({
          url,
          method,
          body: typeof init?.body === "string" ? init.body : "",
          confirm: new Headers(init?.headers).get("x-confirm"),
        });
        return new Response("null", { status: 200 });
      }
      if (url.includes("/api/nodes/%2A/workers") || url.includes("/api/nodes/*/workers")) {
        return new Response(
          JSON.stringify({
            n1: [
              {
                id: 7,
                name: "block_resync",
                state: "busy",
                errors: 1,
                progress: "1/4",
              },
            ],
            n2: [
              {
                id: 8,
                name: "block_rc",
                state: "done",
                errors: 0,
                progress: "",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("n1")).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.getByText("n2")).toBeTruthy();
  expect(screen.getByText("block_rc")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Repair type" }), {
    target: { value: "tables" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start repair" }));
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(repairs).toEqual([]);
  fireEvent.change(screen.getByLabelText("Type * to confirm"), { target: { value: "*" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(repairs).toEqual([
      {
        url: "/api/nodes/*/repair",
        method: "POST",
        body: JSON.stringify({ repairType: "tables" }),
        confirm: "yes",
      },
    ]);
  });
  expect(window.location.hash).toBe("#workers/*");
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const workerRow = {
  id: 7,
  name: "block_resync",
  state: "busy",
  errors: 3,
  progress: "1/4",
};

function renderWorkers() {
  window.location.hash = "#workers/n1";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Workers />
    </QueryClientProvider>,
  );
  return client;
}

test("shows Loading workers and marks the workers section busy on the first load", async () => {
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
  renderWorkers();
  const section = screen.getByRole("region", { name: "Workers" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading workers").getAttribute("role")).toBe("status");
  expect(screen.getByText("Loading workers")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no workers.")).toBeNull();
  expect(screen.queryByText("Refreshing workers")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Busy only" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Errors only" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save variable" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start repair" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Details 7/ })).toBeNull();
  release(json([workerRow]));
  expect(await screen.findByRole("button", { name: /Details 7/ })).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Workers" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByLabelText("Loading workers")).toBeNull();
  expect(screen.queryByText("Loading workers")).toBeNull();
});

test("says there are no workers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/workers");
      expect(init?.credentials).toBe("include");
      return json([]);
    }),
  );
  renderWorkers();
  expect((await screen.findByText("There are no workers.")).textContent).toBe(
    "There are no workers.",
  );
  expect(screen.getByText("There are no workers.").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /Details 7/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Busy only" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Errors only" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start repair" })).toBeTruthy();
  expect(screen.queryByLabelText("Loading workers")).toBeNull();
  expect(screen.queryByText("Loading workers")).toBeNull();
  expect(screen.getByRole("region", { name: "Workers" }).getAttribute("aria-busy")).toBe("false");
});

test("shows the API code and requests the worker list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/workers");
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json({ code: "upstream_failed", message: "Garage returned an error" }, 502);
      }
      return json([workerRow]);
    }),
  );
  renderWorkers();
  expect((await screen.findByText("Garage returned an error")).textContent).toBe(
    "Garage returned an error",
  );
  expect(screen.getByText("upstream_failed").textContent).toBe("upstream_failed");
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no workers.")).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Busy only" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start repair" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: /Details 7/ })).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps one visible worker row while a later fetch refreshes", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/nodes/n1/workers");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json([workerRow]));
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderWorkers();
  expect(await screen.findByRole("button", { name: /Details 7/ })).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.queryByText("Refreshing workers")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["nodes", "n1", "workers"] });
  expect(await screen.findByText("Refreshing workers")).toBeTruthy();
  expect(screen.getByText("block_resync")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Details 7/ })).toBeTruthy();
  expect(screen.queryByLabelText("Loading workers")).toBeNull();
  expect(screen.queryByText("Loading workers")).toBeNull();
  expect(screen.getByRole("region", { name: "Workers" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByRole("alert")).toBeNull();
  releaseNext(json([workerRow]));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing workers")).toBeNull();
  });
  expect(screen.getByRole("button", { name: /Details 7/ })).toBeTruthy();
  expect(calls).toBe(2);
});

test("says no node is selected", () => {
  window.location.hash = "#workers";
  expect(workersNodeId(window.location.hash)).toBeNull();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Workers />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("heading", {name:"Select node"})).toBeTruthy();
});

 test("ordinary workers entry offers node navigation", async () => {
  window.location.hash = "#workers";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ layoutVersion: 1, nodes: [{id: "n1", hostname: "alpha", isUp: true, draining: false}] }), {status:200})));
  const client = new QueryClient({defaultOptions: {queries: {retry:false}}});
  render(<QueryClientProvider client={client}><Workers /></QueryClientProvider>);
  const link = await screen.findByRole("link", {name: "alpha"});
  expect(link.getAttribute("href")).toBe("#workers/n1");
  fireEvent.click(link);
  expect(window.location.hash).toBe("#workers/n1");
 });


test("worker details focus the originating row panel while loading and keep focus unchanged on refresh", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith("/workers/7")) {
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return Promise.resolve(json([workerRow]));
  }));
  const client = renderWorkers();
  fireEvent.click(await screen.findByRole("button", { name: /Details 7/ }));
  const panel = await screen.findByRole("region", { name: "Details 7: block_resync" });
  expect(panel.closest("tr")?.textContent).toContain("block_resync");
  expect(document.activeElement).toBe(panel);
  expect(within(panel).getByRole("status").textContent).toBe("Loading worker details");
  release(json({ lastError: { message: "rpc timeout" } }));
  expect(await within(panel).findByText("rpc timeout")).toBeTruthy();
  const filter = screen.getByRole("checkbox", { name: "Busy only" });
  filter.focus();
  const refresh = client.refetchQueries({ queryKey: ["nodes", "n1", "worker", 7] });
  await waitFor(() => expect(within(panel).getByRole("status").textContent).toBe("Refreshing worker details"));
  release(json({ lastError: { message: "updated timeout" } }));
  await refresh;
  expect(await within(panel).findByText("updated timeout")).toBeTruthy();
  expect(document.activeElement).toBe(filter);
  client.setQueryData(["nodes", "n1", "workers", false, false], []);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Details 7: block_resync" })).toBeNull());
  client.setQueryData(["nodes", "n1", "workers", false, false], [{ nodeId: "n1", rows: [workerRow] }]);
  const restored = await screen.findByRole("region", { name: "Details 7: block_resync" });
  expect(document.activeElement).toBe(filter);
  fireEvent.click(screen.getByRole("button", { name: /Details 7/ }));
  await waitFor(() => expect(document.activeElement).not.toBe(restored));
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Details 7: block_resync" }));
});

test("worker detail failure stays associated with its row and retries the same worker", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/workers/7")) {
      requests += 1;
      return requests === 1
        ? json({ code: "upstream_failed", message: "Details unavailable" }, 502)
        : json({ lastError: { message: "rpc timeout" } });
    }
    return json([workerRow]);
  }));
  renderWorkers();
  fireEvent.click(await screen.findByRole("button", { name: /Details 7/ }));
  const panel = await screen.findByRole("region", { name: "Details 7: block_resync" });
  expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "Details unavailable upstream_failed");
  fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
  expect(await within(panel).findByText("rpc timeout")).toBeTruthy();
  expect(requests).toBe(2);
});
