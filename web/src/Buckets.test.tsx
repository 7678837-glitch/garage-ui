import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function render(ui: ReactNode) { return rtlRender(<Theme>{ui}</Theme>); }

function selectOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}
HTMLElement.prototype.scrollIntoView = () => {};

async function bucketAction(id: string, action: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Actions ${id}` }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}
async function openSettings(id = "bkt-1") {
  await bucketAction(id, `Edit ${id}`);
  await screen.findByRole("region", { name: "Aliases" });
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

function renderBuckets(canManage = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Buckets canManage={canManage} />
    </QueryClientProvider>,
  );
  return client;
}

type Call = {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  csrf: string | null;
  body: unknown;
};

function recordedCall(input: RequestInfo | URL, init?: RequestInit): Call {
  const headers = new Headers(init?.headers);
  const raw = init?.body;
  return {
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    credentials: init?.credentials,
    csrf: headers.get("x-csrf-token"),
    body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("shows the bucket id and string aliases without letting an alias hide the id", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      if (url.endsWith("/lifecycle")) {
        return json({ lifecycleRules: [] });
      }
      expect(url).toContain("/api/buckets?");
      expect(init?.credentials).toBe("include");
      return json({
        items: [
          {
            id: "bkt-1",
            globalAliases: ["east", "a&b=c"],
            localAliases: ["west", { accessKeyId: "GK", alias: "site" }, 4],
          },
          { id: "bkt-2" },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets();
  expect(await screen.findByText("bkt-1", { selector: "code" })).toBeTruthy();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getByText("bkt-2", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByText("west")).toBeTruthy();
  expect(screen.getByText("site")).toBeTruthy();
  expect(screen.queryByText("GK")).toBeNull();
  expect(screen.queryByText("4")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("loads the next page at the offset after the rows already shown", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname.endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      if (url.pathname.endsWith("/lifecycle")) {
        return json({ lifecycleRules: [] });
      }
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      const offset = url.searchParams.get("offset");
      if (offset === "0") {
        return json({
          items: [{ id: "first", globalAliases: ["a&b=c"] }],
          hasMore: true,
        });
      }
      if (offset === "1") {
        return json({
          items: [{ id: "second", localAliases: ["kept"] }],
          hasMore: false,
        });
      }
      return json({ message: "unexpected offset" }, 500);
    }),
  );
  renderBuckets();
  expect(await screen.findByText("first", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByText("More buckets are available.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("first", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(screen.queryByText("More buckets are available.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(calls.some((call) => call.startsWith("/api/buckets?offset=1"))).toBe(true);
  const limits = calls.map((call) => new URL(call, "http://ui.local").searchParams.get("limit"));
  expect(limits).toEqual([limits[0], limits[0]]);
});

test("shows the error message when the bucket list request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderBuckets();
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows Loading buckets and marks the buckets section busy on the first load", async () => {
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
  renderBuckets();
  const section = screen.getByRole("region", { name: "Buckets" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading buckets").getAttribute("role")).toBe("status");
  expect(screen.getByText("Loading buckets")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  expect(screen.queryByText("Refreshing buckets")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  release(json({ items: [], hasMore: false }));
  expect(await screen.findByText("There are no buckets.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByLabelText("Loading buckets")).toBeNull();
  expect(screen.queryByText("Loading buckets")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
});

test("keeps a visible bucket id while a later fetch refreshes the list", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname.endsWith("/cors")) {
        return Promise.resolve(json({ corsRules: [] }));
      }
      if (url.pathname.endsWith("/lifecycle")) {
        return Promise.resolve(json({ lifecycleRules: [] }));
      }
      expect(url.pathname).toBe("/api/buckets");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          json({ items: [{ id: "bkt-9", globalAliases: ["kept"] }], hasMore: false }),
        );
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderBuckets();
  expect(await screen.findByText("bkt-9", { selector: "code" })).toBeTruthy();
  expect(screen.queryByText("Refreshing buckets")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["buckets"] });
  expect(await screen.findByText("Refreshing buckets")).toBeTruthy();
  expect(screen.getByText("bkt-9", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(screen.queryByLabelText("Loading buckets")).toBeNull();
  expect(screen.queryByText("Loading buckets")).toBeNull();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("true");
  releaseNext(json({ items: [{ id: "bkt-9", globalAliases: ["kept"] }], hasMore: false }));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing buckets")).toBeNull();
  });
  expect(screen.getByText("bkt-9", { selector: "code" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("false");
  expect(calls).toBe(2);
});

test("shows the API code and requests the bucket list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname.endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      if (url.pathname.endsWith("/lifecycle")) {
        return json({ lifecycleRules: [] });
      }
      expect(url.pathname).toBe("/api/buckets");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json(
          { code: "upstream_failed", message: "Garage returned an error" },
          502,
        );
      }
      return json({ items: [{ id: "bkt-1", globalAliases: ["photos"] }], hasMore: false });
    }),
  );
  renderBuckets();
  expect(await screen.findByText("Garage returned an error")).toBeTruthy();
  expect(screen.getByText("upstream_failed")).toBeTruthy();
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("bkt-1", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps the loaded rows when the next page fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const offset = new URL(String(input), "http://ui.local").searchParams.get("offset");
      if (offset === "0") {
        return json({ items: [{ id: "first" }], hasMore: true });
      }
      return json({ message: "page failed" }, 502);
    }),
  );
  renderBuckets();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("page failed")).toBeTruthy();
  expect(screen.getByText("first", { selector: "code" })).toBeTruthy();
});

test("explains an empty list and lets an admin create a bucket with only a global alias", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST" && call.url === "/api/buckets") {
        created = true;
        return new Response(null, { status: 204 });
      }
      if (call.url.startsWith("/api/buckets?")) {
        return json({
          items: created ? [{ id: "bucket-new", globalAliases: ["photos"] }] : [],
          hasMore: false,
        });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderBuckets(true);
  const createPanel = screen.queryByRole("button", { name: "Create" });
  if (createPanel) fireEvent.click(createPanel);
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Global alias" }), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  expect(await screen.findByText("bucket-new", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("Bucket created")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Global alias" }) as HTMLInputElement).value).toBe("");
  const post = calls.find((call) => call.method === "POST" && call.url === "/api/buckets");
  expect(post).toEqual({
    url: "/api/buckets",
    method: "POST",
    credentials: "include",
    csrf: "csrf-token",
    body: { globalAlias: "photos" },
  });
  expect(JSON.stringify(post?.body)).not.toContain("localAlias");
});

test("refreshes after creating a bucket while the initial list response is pending", async () => {
  let releaseInitial: (response: Response) => void = () => {};
  let listCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "POST" && call.url === "/api/buckets") {
        return Promise.resolve(json({ id: "bucket-new" }));
      }
      if (call.url.startsWith("/api/buckets?")) {
        listCalls += 1;
        if (listCalls === 1) {
          return new Promise<Response>((resolve) => {
            releaseInitial = resolve;
          });
        }
        return Promise.resolve(json({
          items: [{ id: "bucket-new", globalAliases: ["photos"] }],
          hasMore: false,
        }));
      }
      if (call.url.endsWith("/cors")) {
        return Promise.resolve(json({ corsRules: [] }));
      }
      if (call.url.endsWith("/lifecycle")) {
        return Promise.resolve(json({ lifecycleRules: [] }));
      }
      return Promise.resolve(json({}));
    }),
  );
  renderBuckets(true);
  const createPanel = screen.queryByRole("button", { name: "Create" });
  if (createPanel) fireEvent.click(createPanel);
  expect(screen.getByLabelText("Loading buckets")).toBeTruthy();
  expect(listCalls).toBe(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Global alias" }), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  expect(await screen.findByText("Bucket created")).toBeTruthy();
  await act(async () => {
    releaseInitial(json({ items: [], hasMore: false }));
  });
  expect(await screen.findByText("bucket-new", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.queryByText("There are no buckets. Create the first bucket.")).toBeNull();
  expect(listCalls).toBe(2);
});

test("omits globalAlias when the create form is blank and keeps the value when create fails", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST") {
        return json({ message: "name taken" }, 409);
      }
      return json({ items: [], hasMore: false });
    }),
  );
  renderBuckets(true);
  const createPanel = screen.queryByRole("button", { name: "Create" });
  if (createPanel) fireEvent.click(createPanel);
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  await waitFor(() => {
    expect(calls.some((call) => call.method === "POST")).toBe(true);
  });
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({});
  fireEvent.change(screen.getByRole("textbox", { name: "Global alias" }), { target: { value: " photos " } });
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
  expect(screen.getByText("name taken")).toBeTruthy();
  expect(screen.queryByText("Bucket created")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Global alias" }) as HTMLInputElement).value).toBe(" photos ");
  expect(calls.filter((call) => call.method === "POST")[1]?.body).toEqual({ globalAlias: " photos " });
});

test("a viewer sees the empty list and does not call bucket write routes", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({
        items: [{ id: "bkt-1", globalAliases: ["east"], localAliases: [{ alias: "site", accessKeyId: "GK" }] }],
        hasMore: false,
      });
    }),
  );
  renderBuckets(false);
  expect(await screen.findByText("bkt-1", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
  expect(screen.getByText("site")).toBeTruthy();
  expect(screen.queryByText("GK")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete bkt-1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add alias to bkt-1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove global alias east" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove local alias site for GK" })).toBeNull();
  expect(
    calls.every(
      (call) =>
        call.method === "GET" &&
        (call.url.startsWith("/api/buckets?") ||
          call.url.endsWith("/cors") ||
          call.url.endsWith("/lifecycle")),
    ),
  ).toBe(true);
});

test("cancels a bucket delete without a request, then confirms the delete", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return json({
        items: deleted ? [] : [{ id: "bkt-1", globalAliases: ["east"] }],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await bucketAction("bkt-1", "Delete bkt-1");
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("bkt-1");
  expect(dialog.textContent).toContain("still contains objects");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions bkt-1" })));
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  await bucketAction("bkt-1", "Delete bkt-1");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  await bucketAction("bkt-1", "Delete bkt-1");
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  expect(await screen.findByText("Bucket deleted")).toBeTruthy();
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  expect(screen.queryByText("bkt-1", { selector: "code" })).toBeNull();
  expect(calls.find((call) => call.method === "DELETE")).toEqual({
    url: "/api/buckets/bkt-1",
    method: "DELETE",
    credentials: "include",
    csrf: "csrf-token",
    body: undefined,
  });
});

test("shows the API message when deleting a bucket fails and keeps the bucket listed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "DELETE") {
        return json({ message: "Bucket is not empty" }, 409);
      }
      return json({ items: [{ id: "bkt-1" }], hasMore: false });
    }),
  );
  renderBuckets(true);
  await bucketAction("bkt-1", "Delete bkt-1");
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  expect(await screen.findByText("Bucket is not empty")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("bkt-1");
  expect(screen.getByText("bkt-1", { selector: "code" })).toBeTruthy();
  expect(screen.queryByText("Bucket deleted")).toBeNull();
});

test("shows the API message when removing an alias fails and keeps the alias", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "DELETE") {
        return json({ message: "Alias is still in use" }, 409);
      }
      return json({ items: [{ id: "bkt-1", globalAliases: ["east"] }], hasMore: false });
    }),
  );
  renderBuckets(true);
  await openSettings();
  fireEvent.click(screen.getByRole("button", { name: "Remove global alias east" }));
  expect(await screen.findByText("Alias is still in use")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove global alias east" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Aliases" })).getByText("east")).toBeTruthy();
});

test("adds and removes a global alias without sending a bucket id", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let aliases = ["east"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST" && call.url === "/api/buckets/bkt-1/aliases") {
        aliases = [...aliases, "photos"];
        return new Response(null, { status: 204 });
      }
      if (call.method === "DELETE" && call.url === "/api/buckets/bkt-1/aliases") {
        aliases = aliases.filter((name) => name !== "east");
        return new Response(null, { status: 204 });
      }
      if (call.url === "/api/buckets/bkt-1") return json({ id: "bkt-1", globalAliases: aliases });
      return json({
        items: [{ id: "bkt-1", globalAliases: aliases }],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await within(screen.getByRole("region", { name: "Aliases" })).findByText("east")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
  fireEvent.change(screen.getByLabelText("Global alias for bkt-1"), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Add alias to bkt-1" }));
  expect(await screen.findByText("photos")).toBeTruthy();
  expect(screen.getByText("Alias added")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove global alias east" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Remove global alias east" })).toBeNull();
  });
  expect(within(screen.getByRole("region", { name: "Aliases" })).getByText("photos")).toBeTruthy();
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({ globalAlias: "photos" });
  expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({ globalAlias: "east" });
  expect(calls.find((call) => call.method === "POST")?.csrf).toBe("csrf-token");
  expect(JSON.stringify(calls.filter((call) => call.method !== "GET").map((call) => call.body))).not.toContain(
    "bucketId",
  );
});

test("adds and removes a local alias with its access key and keeps the draft when add fails", async () => {
  const calls: Call[] = [];
  let fail = true;
  let localAliases: { alias: string; accessKeyId: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST" && fail) {
        return json({ message: "Unknown access key" }, 400);
      }
      if (call.method === "POST") {
        localAliases = [{ alias: "site", accessKeyId: "GK1" }];
        return new Response(null, { status: 204 });
      }
      if (call.method === "DELETE") {
        localAliases = [];
        return new Response(null, { status: 204 });
      }
      if (call.url === "/api/buckets/bkt-1") return json({ id: "bkt-1", localAliases });
      return json({ items: [{ id: "bkt-1", localAliases }], hasMore: false });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByText("bkt-1", { selector: "code" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
  fireEvent.click(screen.getByRole("radio", { name: "Local for bkt-1" }));
  fireEvent.change(screen.getByLabelText("Local alias for bkt-1"), { target: { value: "site" } });
  fireEvent.change(screen.getByLabelText("Access key for bkt-1"), { target: { value: "GK1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add alias to bkt-1" }));
  expect(await screen.findByText("Unknown access key")).toBeTruthy();
  expect(screen.queryByText("Alias added")).toBeNull();
  expect((screen.getByLabelText("Local alias for bkt-1") as HTMLInputElement).value).toBe("site");
  expect((screen.getByLabelText("Access key for bkt-1") as HTMLInputElement).value).toBe("GK1");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Add alias to bkt-1" }));
  await screen.findByText("Alias added");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("button", { name: "Remove local alias site for GK1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove local alias site for GK1" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Remove local alias site for GK1" })).toBeNull();
  });
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts[0]?.body).toEqual({ localAlias: "site", accessKeyId: "GK1" });
  expect(posts[1]?.body).toEqual({ localAlias: "site", accessKeyId: "GK1" });
  expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
    localAlias: "site",
    accessKeyId: "GK1",
  });
  expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/buckets/bkt-1/aliases");
});

test("shows object and byte usage, and says when a quota is not set", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          {
            id: "bkt-1",
            objects: 4,
            bytes: 1000,
            quotas: { maxSize: 5000, maxObjects: 12 },
          },
          {
            id: "bkt-2",
            objects: 2,
            bytes: 3,
            quotas: { maxSize: null, maxObjects: null },
          },
        ],
        hasMore: false,
      }),
    ),
  );
  renderBuckets();
  expect(await screen.findByText("4 of 12 objects", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("1000 B", { selector: ".ui-bucket-usage-desktop code" })).toBeTruthy();
  expect(screen.getByText("5000 B", { selector: ".ui-bucket-usage-desktop code" })).toBeTruthy();
  expect(screen.getByText("1 KB", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("5 KB", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("2 objects. Object quota is not set", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("3 B", { selector: ".ui-bucket-usage-desktop code" })).toBeTruthy();
  expect(screen.getByText("Size quota is not set", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
});

test("sends an unchanged maxSize as the digit text from the list response", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const bodies: string[] = [];
  const page =
    '{"items":[{"id":"bkt-1","objects":4,"bytes":1000,"quotas":{"maxSize":9007199254740993,"maxObjects":12}}],"hasMore":false}';
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        bodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      }
      if (String(input) === "/api/buckets/bkt-1") return new Response(page.slice(page.indexOf("[{" ) + 1, page.indexOf("}],") + 1), { status: 200 });
      expect(String(input)).toContain("/api/buckets?");
      expect(init?.credentials).toBe("include");
      return new Response(page, { status: 200 });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByText("4 of 12 objects")).toBeTruthy();
  expect(
    screen.getByText("9007199254740993 B", { selector: "code" }),
  ).toBeTruthy();
  const size = screen.getByLabelText("Max size for bkt-1") as HTMLInputElement;
  const objects = screen.getByLabelText("Max objects for bkt-1") as HTMLInputElement;
  expect(size.value).toBe("9007199254740993");
  expect(objects.value).toBe("12");
  fireEvent.change(objects, { target: { value: "13" } });
  fireEvent.click(screen.getByRole("button", { name: "Save quotas for bkt-1" }));
  await waitFor(() => {
    expect(bodies).toEqual(['{"maxSize":9007199254740993,"maxObjects":13}']);
  });
  expect(bodies[0]).not.toContain("websiteAccess");
  expect(bodies[0]).not.toContain("corsRules");
  expect(bodies[0]).not.toContain("lifecycleRules");
  expect(size.value).toBe("9007199254740993");
});

test("clears both quotas with null and keeps the entered values when save fails", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        bodies.push(String(init?.body));
        return json({ message: "Quota rejected" }, 409);
      }
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 1,
            bytes: 2,
            quotas: { maxSize: 10, maxObjects: 20 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  const size = (await screen.findByLabelText("Max size for bkt-1")) as HTMLInputElement;
  const objects = screen.getByLabelText("Max objects for bkt-1") as HTMLInputElement;
  expect(size.value).toBe("10");
  fireEvent.change(size, { target: { value: "" } });
  fireEvent.change(objects, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save quotas for bkt-1" }));
  expect(await screen.findByText("Quota rejected")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(size.value).toBe("");
  expect(objects.value).toBe("");
  expect(bodies).toEqual(['{"maxSize":null,"maxObjects":null}']);
  expect(screen.getByText("1 of 20 objects")).toBeTruthy();
  expect(screen.getByText("Save failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save quotas for bkt-1" })).toBeTruthy();
});

test("quota form shows unsaved, saving, and saved, and a cancelled leave keeps the hash", async () => {
  document.cookie = "garage_csrf=csrf-token";
  let releaseSave: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        return new Promise<Response>((resolve) => {
          releaseSave = resolve;
        });
      }
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 1,
            bytes: 2,
            quotas: { maxSize: 10, maxObjects: 20 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  const size = (await screen.findByLabelText("Max size for bkt-1")) as HTMLInputElement;
  const objects = screen.getByLabelText("Max objects for bkt-1") as HTMLInputElement;
  expect(size.value).toBe("10");
  expect(objects.value).toBe("20");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(objects, { target: { value: "21" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.change(objects, { target: { value: "20" } });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(objects, { target: { value: "21" } });
  const uploadGuard = () => "upload";
  window.onbeforeunload = uploadGuard;
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  expect(window.onbeforeunload).toBe(uploadGuard);
  window.onbeforeunload = null;
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("tab", { name: "Objects" }));
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe("#bucket/bkt-1/settings");
  expect(objects.value).toBe("21");
  window.location.hash = "#buckets/bkt-1";
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  expect(window.location.hash).toBe("#bucket/bkt-1/settings");
  expect(objects.value).toBe("21");
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  expect(confirm).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Save quotas for bkt-1" }));
  expect(await screen.findByText("Saving")).toBeTruthy();
  const pending = screen.getByRole("button", { name: "Saving quotas" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  const finish = releaseSave;
  if (!finish) {
    throw new Error("quota save did not start");
  }
  finish(new Response(null, { status: 204 }));
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByText("Saving")).toBeNull();
  expect(screen.getByRole("button", { name: "Save quotas for bkt-1" })).toBeTruthy();
  expect(objects.value).toBe("21");
  expect(size.value).toBe("10");
});

test("hides the quota editor when the row has no quotas object", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({
        items: [{ id: "bkt-1", objects: 4, bytes: 9, globalAliases: ["east"] }],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByText("4 objects")).toBeTruthy();
  expect(screen.getByText("9 B", { selector: "code" })).toBeTruthy();
  expect(screen.queryByText("Object quota is not set")).toBeNull();
  expect(screen.queryByText("Size quota is not set")).toBeNull();
  expect(screen.queryByLabelText("Max size for bkt-1")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save quotas for bkt-1" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete bkt-1" })).toBeTruthy();
  await changeBucketHash("#buckets");
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a viewer sees quota usage and does not call PUT", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 4,
            bytes: 1000,
            quotas: { maxSize: 5000, maxObjects: 12 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(false);
  expect(await screen.findByText("4 of 12 objects", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("1000 B", { selector: ".ui-bucket-usage-desktop code" })).toBeTruthy();
  expect(screen.getByText("5000 B", { selector: ".ui-bucket-usage-desktop code" })).toBeTruthy();
  expect(screen.getByText("1 KB", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.getByText("5 KB", { selector: ".ui-bucket-usage-desktop *" })).toBeTruthy();
  expect(screen.queryByLabelText("Max size for bkt-1")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save quotas for bkt-1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});

test("loads permissions for an encoded bucket id only after the row button is clicked", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/buckets/a%26b%3Dc") {
        return json({
          keys: [
            {
              accessKeyId: "GK1",
              name: "photos",
              permissions: { owner: false, read: true, write: false },
              bucketLocalAliases: ["hidden-alias"],
            },
          ],
          websiteConfig: { indexDocument: "index-secret.html" },
          corsRules: [{ AllowedOrigins: ["cors-secret.example"] }],
          lifecycleRules: [{ id: "life-secret" }],
        });
      }
      return json({ items: [{ id: "a&b=c" }], hasMore: false });
    }),
  );
  renderBuckets();
  expect(await screen.findByRole("button", { name: "Actions a&b=c" })).toBeTruthy();
  expect(
    calls.some(
      (call) =>
        call.startsWith("/api/buckets/") && !call.endsWith("/cors") && !call.endsWith("/lifecycle"),
    ),
  ).toBe(false);
  await bucketAction("a&b=c", "Permissions for a&b=c");
  expect(await screen.findByText("GK1", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("read yes")).toBeTruthy();
  expect(screen.getByText("owner no")).toBeTruthy();
  expect(screen.getByText("write no")).toBeTruthy();
  expect(screen.queryByText("hidden-alias")).toBeNull();
  expect(screen.queryByText("index-secret.html")).toBeNull();
  expect(screen.queryByText("cors-secret.example")).toBeNull();
  expect(screen.queryByText("life-secret")).toBeNull();
  expect(
    calls.filter(
      (call) =>
        call.startsWith("/api/buckets/") && !call.endsWith("/cors") && !call.endsWith("/lifecycle"),
    ),
  ).toEqual([
    "/api/buckets/a%26b%3Dc",
  ]);
});

test("an object address hides create and the table, and back returns to #buckets", async () => {
  window.location.hash = "#buckets/bkt-1/photos/2024/";
  const prefixes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/buckets/bkt-1/objects") {
        prefixes.push(url.searchParams.get("prefix") ?? "");
        return json({
          prefix: url.searchParams.get("prefix") ?? "",
          entries: [
            {
              kind: "object",
              key: "photos/2024/a.txt",
              size: 4,
              etag: "abc",
              lastModified: "2026-10-11T00:00:00Z",
            },
          ],
          next: null,
        });
      }
      return json({ items: [{ id: "bkt-1", globalAliases: ["east"] }], hasMore: false });
    }),
  );
  renderBuckets(true);
  expect(await screen.findByRole("button", { name: "Back to buckets" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "photos/2024/a.txt" })).toBeTruthy();
  expect(prefixes).toContain("photos/2024/");
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open objects (bkt-1)" })).toBeNull();
  expect(screen.queryByText("east")).toBeNull();
  expect(screen.queryByLabelText("Filter buckets")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to buckets" }));
  expect(window.location.hash).toBe("#buckets");
  expect(await screen.findByRole("button", { name: "Create" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open objects (bkt-1)" })).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
  expect(screen.getByLabelText("Filter buckets")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back to buckets" })).toBeNull();
});

function bucketRowText(): string[] {
  return screen.getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
}

test("filters loaded buckets from the query string and keeps that choice in the address", async () => {
  window.history.replaceState(null, "", "/?buckets=EAST&keep=1#kept");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      if (String(input).endsWith("/lifecycle")) {
        return json({ lifecycleRules: [] });
      }
      calls += 1;
      return json({
        items: [
          { id: "zed", globalAliases: ["mango"] },
          { id: "amy", globalAliases: ["east"] },
          { id: "nope", globalAliases: ["west"] },
        ],
        hasMore: true,
      });
    }),
  );
  renderBuckets();
  expect(await screen.findByText("amy", { selector: "code" })).toBeTruthy();
  expect(screen.queryByText("zed", { selector: "code" })).toBeNull();
  expect(screen.queryByText("nope", { selector: "code" })).toBeNull();
  expect((screen.getByLabelText("Filter buckets") as HTMLInputElement).value).toBe("EAST");
  expect(screen.getByText("Default order is Id.").textContent).toBe("Default order is Id.");
  expect(screen.getByText("Only loaded rows").textContent).toBe("Only loaded rows");
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  expect(window.location.hash).toBe("#kept");
  expect(window.location.search).toContain("buckets=EAST");
  expect(window.location.search).toContain("keep=1");
  expect(calls).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter buckets"), { target: { value: "" } });
  expect(screen.getByText("zed", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("amy", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("nope", { selector: "code" })).toBeTruthy();
  expect(bucketRowText()[0]).toContain("zed");
  expect(window.location.search).toBe("?keep=1");
  expect(window.location.hash).toBe("#kept");
  expect(calls).toBe(1);

  selectOption("Sort buckets", "Alias");
  expect(bucketRowText()[0]).toContain("amy");
  expect(bucketRowText()[1]).toContain("zed");
  expect(bucketRowText()[2]).toContain("nope");
  const sorted = new URLSearchParams(window.location.search);
  expect(sorted.get("bucketsSort")).toBe("alias");
  expect(sorted.get("buckets")).toBeNull();
  expect(sorted.get("keep")).toBe("1");
  expect(window.location.hash).toBe("#kept");
  expect(calls).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?buckets=missing&keep=1#kept");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByText("amy", { selector: "code" })).toBeNull();
  expect(screen.queryByText("zed", { selector: "code" })).toBeNull();
  expect(screen.queryByText("nope", { selector: "code" })).toBeNull();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect((screen.getByLabelText("Filter buckets") as HTMLInputElement).value).toBe("missing");
  expect(screen.getByRole("combobox", { name: "Sort buckets" }).textContent).toBe("Id");
  expect(window.location.hash).toBe("#kept");
  expect(calls).toBe(1);
});

test("sorts loaded buckets by created time and keeps the choice in the address", async () => {
  window.history.replaceState(null, "", "/?keep=1#kept");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          { id: "later-bucket", globalAliases: ["later"], created: "2026-10-12T00:00:00Z" },
          { id: "earlier-bucket", globalAliases: ["earlier"], created: "2026-01-02T00:00:00Z" },
          { id: "undated-bucket", globalAliases: ["undated"] },
        ],
        hasMore: false,
      }),
    ),
  );
  renderBuckets();
  expect(await screen.findByText("later-bucket", { selector: "code" })).toBeTruthy();
  expect(bucketRowText()[0]).toContain("later-bucket");
  expect(bucketRowText()[1]).toContain("earlier-bucket");
  expect(bucketRowText()[2]).toContain("undated-bucket");
  selectOption("Sort buckets", "Created");
  expect(bucketRowText()[0]).toContain("earlier-bucket");
  expect(bucketRowText()[1]).toContain("later-bucket");
  expect(bucketRowText()[2]).toContain("undated-bucket");
  expect(window.location.search).toContain("bucketsSort=created");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#kept");
  expect(screen.getByRole("combobox", { name: "Sort buckets" }).textContent).toBe("Created");
});

test("saves a bucket CORS rule after showing the diff", async () => {
  const calls: Call[] = [];
  const cors = {
    corsRules: [
      {
        ID: "photos",
        AllowedOrigin: ["https://old.example"],
        AllowedMethod: ["GET"],
        AllowedHeader: [],
        ExposeHeader: [],
        MaxAgeSeconds: 60,
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.url === "/api/buckets/bkt-1/cors") {
        return json(cors);
      }
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 4,
            bytes: 1000,
            quotas: { maxSize: 5000, maxObjects: 12 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByRole("button", { name: "Edit CORS" })).toBeTruthy();
  const corsGets = () =>
    calls.filter((call) => call.method === "GET" && call.url === "/api/buckets/bkt-1/cors");
  expect(corsGets()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Edit CORS" }));
  const origin = (await screen.findByLabelText("AllowedOrigin")) as HTMLInputElement;
  expect(origin.value).toBe("https://old.example");
  expect(corsGets()).toHaveLength(1);
  fireEvent.change(origin, { target: { value: "https://new.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Review CORS" }));
  const current = await screen.findByLabelText("Current");
  const next = screen.getByLabelText("Next");
  expect(current.tagName).toBe("PRE");
  expect(next.tagName).toBe("PRE");
  expect(current.textContent).toContain("https://old.example");
  expect(current.textContent).not.toContain("https://new.example");
  expect(next.textContent).toContain("https://new.example");
  expect(next.textContent).not.toContain("https://old.example");
  expect(corsGets()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Save CORS" }));
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.url).toBe("/api/buckets/bkt-1/cors");
  expect(put?.body).toEqual({
    corsRules: [
      {
        ID: "photos",
        AllowedOrigin: ["https://new.example"],
        AllowedMethod: ["GET"],
        AllowedHeader: [],
        ExposeHeader: [],
        MaxAgeSeconds: 60,
      },
    ],
  });
  expect(JSON.stringify(put?.body)).not.toContain("lifecycleRules");
  expect(corsGets()).toHaveLength(2);
  cleanup();
  calls.length = 0;
  renderBuckets(false);
  await screen.findByRole("region", { name: "Aliases" });
  expect(await screen.findByText("photos")).toBeTruthy();
  expect(screen.getByText("https://old.example")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit CORS" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save CORS" })).toBeNull();
});

test("saves a bucket lifecycle rule after showing the diff", async () => {
  const calls: Call[] = [];
  const lifecycle = {
    lifecycleRules: [
      {
        ID: "logs",
        Status: "Enabled",
        Filter: {
          Prefix: "logs/",
          ObjectSizeGreaterThan: 10,
          ObjectSizeLessThan: 100,
        },
        Expiration: { Days: 30 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.url === "/api/buckets/bkt-1/lifecycle") {
        return json(lifecycle);
      }
      if (call.url.endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 4,
            bytes: 1000,
            quotas: { maxSize: 5000, maxObjects: 12 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByRole("button", { name: "Edit lifecycle" })).toBeTruthy();
  const lifecycleGets = () =>
    calls.filter((call) => call.method === "GET" && call.url === "/api/buckets/bkt-1/lifecycle");
  expect(lifecycleGets()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Edit lifecycle" }));
  const days = (await screen.findByLabelText("Expiration.Days")) as HTMLInputElement;
  expect(days.value).toBe("30");
  expect(lifecycleGets()).toHaveLength(1);
  fireEvent.change(days, { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: "Review lifecycle" }));
  const current = await screen.findByLabelText("Current");
  const next = screen.getByLabelText("Next");
  expect(current.tagName).toBe("PRE");
  expect(next.tagName).toBe("PRE");
  expect(current.textContent).toContain("30");
  expect(next.textContent).toContain("7");
  expect(next.textContent).not.toContain("30");
  expect(lifecycleGets()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Save lifecycle" }));
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  const put = calls.find((call) => call.method === "PUT");
  expect(put?.url).toBe("/api/buckets/bkt-1/lifecycle");
  expect(put?.body).toEqual({
    lifecycleRules: [
      {
        ID: "logs",
        Status: "Enabled",
        Filter: {
          Prefix: "logs/",
          ObjectSizeGreaterThan: 10,
          ObjectSizeLessThan: 100,
        },
        Expiration: { Days: 7 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      },
    ],
  });
  expect(JSON.stringify(put?.body)).not.toContain("corsRules");
  expect(lifecycleGets()).toHaveLength(2);
  cleanup();
  calls.length = 0;
  renderBuckets(false);
  await screen.findByRole("region", { name: "Aliases" });
  expect(await screen.findByText("logs")).toBeTruthy();
  expect(screen.getByText("Enabled")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit lifecycle" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save lifecycle" })).toBeNull();
});

test("shows incomplete uploads and cleans up older than one hour", async () => {
  const calls: Call[] = [];
  let cleaned = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.url.endsWith("/multipart")) {
        return json(
          cleaned
            ? { uploads: [] }
            : {
                uploads: [
                  {
                    key: "old.bin",
                    uploadId: "up-old",
                    initiated: "2000-01-01T00:00:00Z",
                  },
                ],
              },
        );
      }
      if (call.url.endsWith("/cleanup-uploads")) {
        cleaned = true;
        return json({ uploadsDeleted: 1 });
      }
      if (call.url.endsWith("/lifecycle")) {
        return json({ lifecycleRules: [] });
      }
      if (call.url.endsWith("/cors")) {
        return json({ corsRules: [] });
      }
      return json({
        items: [
          {
            id: "bkt-1",
            objects: 4,
            bytes: 1000,
            quotas: { maxSize: 5000, maxObjects: 12 },
          },
        ],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  await openSettings();
  expect(await screen.findByRole("button", { name: "Incomplete uploads" })).toBeTruthy();
  expect(calls.some((call) => call.url.endsWith("/multipart"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Incomplete uploads" }));
  expect(await screen.findByText("old.bin")).toBeTruthy();
  expect(screen.getByText("up-old")).toBeTruthy();
  expect(screen.getByText("2000-01-01T00:00:00Z")).toBeTruthy();
  const hours = screen.getByLabelText("Older than hours") as HTMLInputElement;
  expect(hours.value).toBe("");
  const cleanUp = screen.getByRole("button", { name: "Clean up" }) as HTMLButtonElement;
  expect(cleanUp.disabled).toBe(true);
  fireEvent.change(hours, { target: { value: "1" } });
  expect((screen.getByRole("button", { name: "Clean up" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
  await waitFor(() => {
    expect(screen.queryByText("up-old")).toBeNull();
  });
  expect(screen.getByText("Cleaned up 1")).toBeTruthy();
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe("/api/buckets/bkt-1/cleanup-uploads");
  expect(posts[0]?.body).toEqual({ olderThanSecs: 3600 });
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  cleanup();
  calls.length = 0;
  renderBuckets(false);
  expect(await screen.findByText("bkt-1", { selector: "code" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Incomplete uploads" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clean up" })).toBeNull();
});

test("keeps a long bucket identifier complete for accessible naming and inspection", async () => {
  const resourceId = "b".repeat(64);
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ id: resourceId, quotas: { maxSize: 5000, maxObjects: 12 } }], hasMore: false })));
  renderBuckets(true);
  const link = await screen.findByRole("link", { name: `Bucket (${resourceId})` });
  expect(link.textContent).toBe("Bucket");
  expect(link.getAttribute("title")).toBe(resourceId);
  expect(link.getAttribute("href")).toBe(`#bucket/${resourceId}/overview`);
  await openSettings(resourceId);
  expect(screen.getByText(resourceId, { selector: "code" })).toBeTruthy();
});

test("creation uses a dialog and row settings preserve a rejected departure draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ id: "compact", quotas: { maxSize: 10, maxObjects: 20 } }], hasMore: false })));
  renderBuckets(true);
  expect(await screen.findByText("compact", { selector: "code" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Global alias" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("dialog", { name: "Create bucket" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Global alias" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await openSettings("compact");
  fireEvent.change(screen.getByLabelText("Max size for compact"), { target: { value: "42" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  const confirmLeave = vi.spyOn(window, "confirm").mockReturnValue(false);
  const before = window.location.hash;
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(confirmLeave).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe(before);
  expect((screen.getByLabelText("Max size for compact") as HTMLInputElement).value).toBe("42");
});

async function changeBucketHash(next: string) {
  const oldURL = window.location.href;
  await act(async () => {
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
  });
}

for (const kind of ["cors", "lifecycle"] as const) {
  for (const delayed of [false, true]) {
    test(`${kind} keeps a rejected departure draft and discards it on accepted bucket switch (${delayed ? "delayed" : "loaded"} B)`, async () => {
      window.history.replaceState(null, "", "#bucket/A/settings");
      const calls: Call[] = [];
      let releaseB: (response: Response) => void = () => {};
      const label = kind === "cors" ? "CORS" : "lifecycle";
      const field = kind === "cors" ? "AllowedOrigin" : "Expiration.Days";
      const edited = kind === "cors" ? "https://edited.example" : "7";
      const payload = (id: string) => kind === "cors"
        ? { corsRules: [{ ID: id, AllowedOrigin: [`https://${id}.example`], AllowedMethod: ["GET"] }] }
        : { lifecycleRules: [{ ID: id, Status: "Enabled", Filter: { Prefix: `${id}/` }, Expiration: { Days: 30 } }] };
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordedCall(input, init);
        calls.push(call);
        if (call.method === "PUT") return new Response(null, { status: 204 });
        if (call.url.endsWith(`/${kind}`)) return json(payload(call.url.includes("/A/") ? "A" : "B"));
        if (call.url === "/api/buckets/B" && delayed) return new Promise<Response>((resolve) => { releaseB = resolve; });
        if (call.url === "/api/buckets/A" || call.url === "/api/buckets/B") return json({ id: call.url.endsWith("A") ? "A" : "B" });
        return json({ items: delayed ? [{ id: "A" }] : [{ id: "A" }, { id: "B" }], hasMore: false });
      }));
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      const client = renderBuckets(true);
      fireEvent.click(await screen.findByRole("button", { name: `Edit ${label}` }));
      fireEvent.change(await screen.findByLabelText(field), { target: { value: edited } });
      fireEvent.click(screen.getByRole("button", { name: `Review ${label}` }));
      expect((await screen.findByLabelText("Next")).textContent).toContain(edited);
      await client.invalidateQueries({ queryKey: [`bucket-${kind}`, "A"] });
      expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(edited);
      await changeBucketHash("#bucket/B/settings");
      expect(confirm).toHaveBeenCalledOnce();
      expect(window.location.hash).toBe("#bucket/A/settings");
      expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(edited);
      confirm.mockReturnValue(true);
      await changeBucketHash("#bucket/B/settings");
      expect(screen.queryByRole("button", { name: `Save ${label}` })).toBeNull();
      expect(screen.queryByLabelText("Next")).toBeNull();
      if (delayed) await act(async () => { releaseB(json({ id: "B" })); });
      fireEvent.click(await screen.findByRole("button", { name: `Edit ${label}` }));
      expect((await screen.findByLabelText(field) as HTMLInputElement).value).not.toBe(edited);
      fireEvent.click(screen.getByRole("button", { name: `Review ${label}` }));
      await screen.findByLabelText("Next");
      fireEvent.click(screen.getByRole("button", { name: `Save ${label}` }));
      await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1));
      expect(calls.find((call) => call.method === "PUT")?.url).toBe(`/api/buckets/B/${kind}`);
      expect(JSON.stringify(calls.find((call) => call.method === "PUT")?.body)).not.toContain(edited);
      await waitFor(() => expect(screen.queryByLabelText("Next")).toBeNull());
      confirm.mockClear();
      await changeBucketHash("#buckets");
      expect(confirm).not.toHaveBeenCalled();
    });
  }
}

test("bucket detail objects discard A's list and deletion selection while B is loading", async () => {
  window.history.replaceState(null, "", "#bucket/A/objects");
  let releaseB: (response: Response) => void = () => {};
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") !== "GET") writes.push(url);
    if (url.startsWith("/api/buckets/A/objects?")) return json({ prefix: "", entries: [{ kind: "object", key: "report.txt", size: 1, lastModified: "2026-10-11T00:00:00Z", etag: "a" }], next: null });
    if (url.startsWith("/api/buckets/B/objects?")) return new Promise<Response>((resolve) => { releaseB = resolve; });
    if (url === "/api/buckets/A/objects/report.txt") return json({ key: "report.txt", size: 1, contentType: "application/octet-stream" });
    return json({ items: [{ id: "A" }, { id: "B" }], hasMore: false });
  }));
  renderBuckets(true);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select report.txt" }));
  expect(screen.getByRole("checkbox", { name: "Select report.txt" }).getAttribute("aria-checked")).toBe("true");
  await changeBucketHash("#bucket/B/objects");
  expect(screen.queryByRole("checkbox", { name: "Select report.txt" })).toBeNull();
  expect(screen.queryByText("report.txt")).toBeNull();
  expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();
  expect(writes).toEqual([]);
  await act(async () => { releaseB(json({ prefix: "", entries: [], next: null })); });
});


test("bucket object departure preserves an active upload on stay and cancels it on leave", async () => {
  window.history.replaceState(null, "", "#bucket/A/objects");
  const requests: { url: string; aborted: boolean }[] = [];
  class UploadRequest {
    url = "";
    aborted = false;
    upload = { onprogress: null };
    onabort: (() => void) | null = null;
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send() { requests.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/objects?")) return json({ prefix: "", entries: [], next: null });
    if (url.endsWith("/objects/new.txt")) return json({ message: "Object not found", code: "not_found" }, 404);
    return json({ items: [{ id: "A" }, { id: "B" }], hasMore: false });
  }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderBuckets(true);
  fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["body"], "new.txt")] } });
  await waitFor(() => expect(requests).toHaveLength(1));
  await changeBucketHash("#bucket/B/objects");
  expect(window.location.hash).toBe("#bucket/A/objects");
  expect(requests[0]?.aborted).toBe(false);
  expect(screen.getByText("new.txt")).toBeTruthy();
  confirm.mockReturnValue(true);
  await changeBucketHash("#bucket/B/objects");
  expect(requests[0]?.aborted).toBe(true);
  expect(screen.queryByText("new.txt")).toBeNull();
  expect(requests[0]?.url).toBe("/api/buckets/A/objects/new.txt");
});


test("bucket settings show one named title and independent readable sections", async () => {
  const id = "abcdef0123456789".repeat(4);
  window.history.replaceState(null, "", `#bucket/${id}/settings`);
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ id, globalAliases: ["Project archives"], objects: 2, bytes: 10, quotas: { maxSize: 100, maxObjects: 5 } }], hasMore: false })));
  renderBuckets(true);
  expect(await screen.findByRole("heading", { level: 2, name: "Project archives" })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 2, name: "Buckets" })).toBeNull();
  for (const name of ["General", "Aliases", "Quotas", "CORS", "Lifecycle", "Incomplete uploads", "Danger zone"]) {
    expect(screen.getByRole("region", { name })).toBeTruthy();
  }
  const quotas = within(screen.getByRole("region", { name: "Quotas" }));
  expect(quotas.getByLabelText(`Max size for ${id}`).closest("label")?.textContent).toBe("Max size");
  expect(quotas.getByRole("button", { name: `Save quotas for ${id}` }).textContent).toBe("Save quotas");
  expect(screen.getByText(id, { selector: "code" })).toBeTruthy();
  expect(screen.getByRole("button", { name: `Delete ${id}` })).toBeTruthy();
});


test.each([
  { shape: "documented detail keys", localAliases: undefined },
  { shape: "detail and list alias objects", localAliases: [{ alias: "site", accessKeyId: "GK1" }] },
  { shape: "detail and keyless list aliases", localAliases: ["site"] },
])("detail local aliases keep their access key without duplicates: $shape", async ({ localAliases }) => {
  window.location.hash = "#bucket/bkt-1/settings";
  const calls: Call[] = [];
  let bucketLocalAliases = ["site"];
  let listedAliases = localAliases;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = recordedCall(input, init);
    calls.push(call);
    if (call.url.endsWith("/cors")) return json({ corsRules: [] });
    if (call.url.endsWith("/lifecycle")) return json({ lifecycleRules: [] });
    if (call.url.endsWith("/aliases") && call.method === "DELETE") {
      bucketLocalAliases = [];
      listedAliases = undefined;
      return json({});
    }
    if (call.url === "/api/buckets/bkt-1") return json({
      id: "bkt-1", globalAliases: ["east"], localAliases: listedAliases,
      keys: [{ accessKeyId: "GK1", name: "Storage key", bucketLocalAliases,
        permissions: { owner: true, read: true, write: true } }],
    });
    return json({ items: [], hasMore: false });
  }));
  renderBuckets(true);
  const remove = await screen.findByRole("button", { name: "Remove local alias site for GK1" });
  expect(screen.getAllByText("site", { exact: true })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Remove local alias site for GK1" })).toHaveLength(1);
  fireEvent.click(remove);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove local alias site for GK1" })).toBeNull());
  expect(calls.find(call => call.url === "/api/buckets/bkt-1/aliases" && call.method === "DELETE")?.body)
    .toEqual({ localAlias: "site", accessKeyId: "GK1" });
});


test("bucket deletion locks cancellation and duplicate submits while pending", async () => {
  let release: (response: Response) => void = () => {};
  let deletes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") { deletes += 1; return new Promise<Response>((resolve) => { release = resolve; }); }
    return json({ items: [{ id: "bkt-1" }], hasMore: false });
  }));
  renderBuckets(true);
  await bucketAction("bkt-1", "Delete bkt-1");
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  const pending = await screen.findByRole("button", { name: "Deleting bucket" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(deletes).toBe(1);
  release(json({ message: "Bucket is not empty" }, 409));
  await screen.findByText("Bucket is not empty");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions bkt-1" })));
});
