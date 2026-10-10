import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Buckets } from "./Buckets";

afterEach(() => {
  cleanup();
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
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
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
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
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
  expect(await screen.findByText("There are no buckets.")).toBeTruthy();
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
  expect(await screen.findByText("There are no buckets.")).toBeTruthy();
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
  expect(await screen.findByText("There are no buckets.")).toBeTruthy();
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
