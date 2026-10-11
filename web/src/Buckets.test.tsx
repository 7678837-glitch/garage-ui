import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";

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
      expect(String(input)).toContain("/api/buckets?");
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
  expect(await screen.findByText("bkt-1")).toBeTruthy();
  expect(screen.getByText("bkt-2")).toBeTruthy();
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
  expect(await screen.findByText("first")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByText("More buckets are available.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
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
  expect(screen.getByText("Loading buckets").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  expect(screen.queryByText("Refreshing buckets")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  release(json({ items: [], hasMore: false }));
  expect(await screen.findByText("There are no buckets.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("false");
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
  expect(await screen.findByText("bkt-9")).toBeTruthy();
  expect(screen.queryByText("Refreshing buckets")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["buckets"] });
  expect(await screen.findByText("Refreshing buckets")).toBeTruthy();
  expect(screen.getByText("bkt-9")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(screen.queryByText("Loading buckets")).toBeNull();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("true");
  releaseNext(json({ items: [{ id: "bkt-9", globalAliases: ["kept"] }], hasMore: false }));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing buckets")).toBeNull();
  });
  expect(screen.getByText("bkt-9")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Buckets" }).getAttribute("aria-busy")).toBe("false");
  expect(calls).toBe(2);
});

test("shows the API code and requests the bucket list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
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
  expect(await screen.findByText("bkt-1")).toBeTruthy();
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
  expect(screen.getByText("first")).toBeTruthy();
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
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Global alias"), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  expect(await screen.findByText("bucket-new")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("Bucket created")).toBeTruthy();
  expect((screen.getByLabelText("Global alias") as HTMLInputElement).value).toBe("");
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
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  await waitFor(() => {
    expect(calls.some((call) => call.method === "POST")).toBe(true);
  });
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({});
  fireEvent.change(screen.getByLabelText("Global alias"), { target: { value: " photos " } });
  fireEvent.click(screen.getByRole("button", { name: "Create bucket" }));
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
  expect(screen.getByText("name taken")).toBeTruthy();
  expect(screen.queryByText("Bucket created")).toBeNull();
  expect((screen.getByLabelText("Global alias") as HTMLInputElement).value).toBe(" photos ");
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
  expect(await screen.findByText("bkt-1")).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
  expect(screen.getByText("site")).toBeTruthy();
  expect(screen.queryByText("GK")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete bkt-1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add alias to bkt-1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove global alias east" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove local alias site for GK" })).toBeNull();
  expect(calls.every((call) => call.method === "GET" && call.url.startsWith("/api/buckets?"))).toBe(true);
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
  fireEvent.click(await screen.findByRole("button", { name: "Delete bkt-1" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("bkt-1");
  expect(dialog.textContent).toContain("still contains objects");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete bkt-1" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete bkt-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  expect(await screen.findByText("Bucket deleted")).toBeTruthy();
  expect(await screen.findByText("There are no buckets. Create the first bucket.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  expect(screen.queryByText("bkt-1")).toBeNull();
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
  fireEvent.click(await screen.findByRole("button", { name: "Delete bkt-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
  expect(await screen.findByText("Bucket is not empty")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("bkt-1");
  expect(screen.getByText("bkt-1")).toBeTruthy();
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
  fireEvent.click(await screen.findByRole("button", { name: "Remove global alias east" }));
  expect(await screen.findByText("Alias is still in use")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove global alias east" })).toBeTruthy();
  expect(screen.getByText("east")).toBeTruthy();
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
      return json({
        items: [{ id: "bkt-1", globalAliases: aliases }],
        hasMore: false,
      });
    }),
  );
  renderBuckets(true);
  expect(await screen.findByText("east")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Global alias for bkt-1"), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Add alias to bkt-1" }));
  expect(await screen.findByText("photos")).toBeTruthy();
  expect(screen.getByText("Alias added")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove global alias east" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Remove global alias east" })).toBeNull();
  });
  expect(screen.getByText("photos")).toBeTruthy();
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
      return json({ items: [{ id: "bkt-1", localAliases }], hasMore: false });
    }),
  );
  renderBuckets(true);
  expect(await screen.findByText("bkt-1")).toBeTruthy();
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
  expect(await screen.findByText("4 of 12 objects")).toBeTruthy();
  expect(screen.getByText("1000 of 5000 bytes (1.00 KB of 5.00 KB)")).toBeTruthy();
  expect(screen.getByText("2 objects. Object quota is not set")).toBeTruthy();
  expect(screen.getByText("3 bytes. Size quota is not set")).toBeTruthy();
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
      expect(String(input)).toContain("/api/buckets?");
      expect(init?.credentials).toBe("include");
      return new Response(page, { status: 200 });
    }),
  );
  renderBuckets(true);
  expect(await screen.findByText("4 of 12 objects")).toBeTruthy();
  expect(
    screen.getByText("1000 of 9007199254740993 bytes (1.00 KB of 9.007199254740993 PB)"),
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
  expect(await screen.findByText("4 objects")).toBeTruthy();
  expect(screen.getByText("9 bytes")).toBeTruthy();
  expect(screen.queryByText("Object quota is not set")).toBeNull();
  expect(screen.queryByText("Size quota is not set")).toBeNull();
  expect(screen.queryByLabelText("Max size for bkt-1")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save quotas for bkt-1" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete bkt-1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
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
  expect(await screen.findByText("4 of 12 objects")).toBeTruthy();
  expect(screen.getByText("1000 of 5000 bytes (1.00 KB of 5.00 KB)")).toBeTruthy();
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
  expect(await screen.findByRole("button", { name: "Permissions for a&b=c" })).toBeTruthy();
  expect(calls.some((call) => call.startsWith("/api/buckets/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for a&b=c" }));
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("read yes")).toBeTruthy();
  expect(screen.getByText("owner no")).toBeTruthy();
  expect(screen.getByText("write no")).toBeTruthy();
  expect(screen.queryByText("hidden-alias")).toBeNull();
  expect(screen.queryByText("index-secret.html")).toBeNull();
  expect(screen.queryByText("cors-secret.example")).toBeNull();
  expect(screen.queryByText("life-secret")).toBeNull();
  expect(calls.filter((call) => call.startsWith("/api/buckets/"))).toEqual(["/api/buckets/a%26b%3Dc"]);
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
  expect(screen.queryByRole("button", { name: "Objects for bkt-1" })).toBeNull();
  expect(screen.queryByText("east")).toBeNull();
  expect(screen.queryByLabelText("Filter buckets")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to buckets" }));
  expect(window.location.hash).toBe("#buckets");
  expect(await screen.findByRole("button", { name: "Create bucket" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Objects for bkt-1" })).toBeTruthy();
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
    vi.fn(async () => {
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
  expect(await screen.findByText("amy")).toBeTruthy();
  expect(screen.queryByText("zed")).toBeNull();
  expect(screen.queryByText("nope")).toBeNull();
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
  expect(screen.getByText("zed")).toBeTruthy();
  expect(screen.getByText("amy")).toBeTruthy();
  expect(screen.getByText("nope")).toBeTruthy();
  expect(bucketRowText()[0]).toContain("zed");
  expect(window.location.search).toBe("?keep=1");
  expect(window.location.hash).toBe("#kept");
  expect(calls).toBe(1);

  fireEvent.change(screen.getByLabelText("Sort buckets"), { target: { value: "alias" } });
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
  expect(screen.queryByText("amy")).toBeNull();
  expect(screen.queryByText("zed")).toBeNull();
  expect(screen.queryByText("nope")).toBeNull();
  expect(screen.queryByText("There are no buckets.")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect((screen.getByLabelText("Filter buckets") as HTMLInputElement).value).toBe("missing");
  expect((screen.getByLabelText("Sort buckets") as HTMLSelectElement).value).toBe("id");
  expect(window.location.hash).toBe("#kept");
  expect(calls).toBe(1);
});
