import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BucketPermissions } from "./BucketPermissions";
import { Buckets } from "./Buckets";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

function renderPermissions(bucketId: string, canManage: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BucketPermissions bucketId={bucketId} canManage={canManage} />
    </QueryClientProvider>,
  );
}

function renderBuckets(canManage: boolean) {
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

const detailJunk = {
  objects: 42,
  bytes: 99,
  quotas: { maxSize: 5, maxObjects: 6 },
  websiteAccess: true,
  websiteConfig: { indexDocument: "index-secret.html" },
  corsRules: [{ AllowedOrigins: ["cors-secret.example"] }],
  lifecycleRules: [{ id: "life-secret" }],
};

test("shows string names and yes or no, and ignores a key with no access key id", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({
        ...detailJunk,
        keys: [
          { name: "no-id" },
          { accessKeyId: "" },
          {
            accessKeyId: "GK0",
            name: "idle",
            permissions: { owner: false, read: false, write: false },
          },
          {
            accessKeyId: "GK1",
            name: "photos",
            permissions: { owner: true, read: false, write: true },
            bucketLocalAliases: ["hidden-alias"],
          },
          {
            accessKeyId: "GK3",
            name: 4,
            permissions: { owner: "true", read: 1, write: false },
          },
        ],
      });
    }),
  );
  renderPermissions("bkt-1", true);
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("GK0")).toBeTruthy();
  expect(screen.getByText("idle")).toBeTruthy();
  expect(screen.getByText("GK3")).toBeTruthy();
  expect(screen.getByText("owner yes")).toBeTruthy();
  expect(screen.getAllByText("owner no")).toHaveLength(2);
  expect(screen.getAllByText("read no")).toHaveLength(3);
  expect(screen.queryByText("read yes")).toBeNull();
  expect(screen.getByText("write yes")).toBeTruthy();
  expect(screen.getAllByText("write no")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Revoke GK1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke GK0" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke GK3" })).toBeNull();
  expect(screen.queryByText("no-id")).toBeNull();
  expect(screen.queryByText("4")).toBeNull();
  expect(screen.queryByText("hidden-alias")).toBeNull();
  expect(screen.queryByText("index-secret.html")).toBeNull();
  expect(screen.queryByText("cors-secret.example")).toBeNull();
  expect(screen.queryByText("life-secret")).toBeNull();
  expect(screen.queryByText("42")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.map((call) => call.url)).toEqual(["/api/buckets/bkt-1"]);
  expect(calls[0]?.method).toBe("GET");
});

test("says when the bucket has no keys", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        keys: [],
        websiteConfig: { indexDocument: "index-secret.html" },
        corsRules: [{ AllowedOrigins: ["cors-secret.example"] }],
        lifecycleRules: [{ id: "life-secret" }],
      }),
    ),
  );
  renderPermissions("bkt-1", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  expect(await screen.findByText("This bucket has no keys.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("index-secret.html")).toBeNull();
  expect(screen.queryByText("cors-secret.example")).toBeNull();
  expect(screen.queryByText("life-secret")).toBeNull();
});

test("shows the API message when the key list fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderPermissions("bkt-1", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.queryByText("This bucket has no keys.")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("does not grant when the access key is blank or no permission is checked", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({ keys: [] });
    }),
  );
  renderPermissions("bkt-1", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  const grant = screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement;
  const form = grant.form;
  if (form === null) {
    throw new Error("missing grant form");
  }
  expect(grant.disabled).toBe(true);
  fireEvent.click(grant);
  fireEvent.submit(form);
  fireEvent.click(screen.getByLabelText("Owner"));
  expect(grant.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "  " } });
  expect(grant.disabled).toBe(true);
  fireEvent.submit(form);
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "GK9" } });
  expect(grant.disabled).toBe(false);
  fireEvent.click(screen.getByLabelText("Owner"));
  expect(grant.disabled).toBe(true);
  fireEvent.submit(form);
  await waitFor(() => {
    expect(calls.some((call) => call.url === "/api/buckets/bkt-1")).toBe(true);
  });
  expect(calls.some((call) => call.method === "POST" || call.method === "DELETE")).toBe(false);
});

test("grants the trimmed access key and reloads that bucket", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let granted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST") {
        granted = true;
        return new Response(null, { status: 204 });
      }
      return json({
        ...detailJunk,
        keys: granted
          ? [
              {
                accessKeyId: "GK1",
                name: "photos",
                permissions: { owner: false, read: true, write: false },
              },
              {
                accessKeyId: "GK9",
                name: "extra",
                permissions: { owner: true, read: false, write: true },
              },
            ]
          : [
              {
                accessKeyId: "GK1",
                name: "photos",
                permissions: { owner: false, read: true, write: false },
              },
            ],
      });
    }),
  );
  renderPermissions("a&b=c", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for a&b=c" }));
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: " GK9 " } });
  fireEvent.click(screen.getByLabelText("Owner"));
  fireEvent.click(screen.getByLabelText("Write"));
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect(await screen.findByText("extra")).toBeTruthy();
  expect(screen.getByText("GK9")).toBeTruthy();
  expect((screen.getByLabelText("Access key") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Owner") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Write") as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText("index-secret.html")).toBeNull();
  const post = calls.find((call) => call.method === "POST");
  expect(post).toEqual({
    url: "/api/buckets/a%26b%3Dc/permissions",
    method: "POST",
    credentials: "include",
    csrf: "csrf-token",
    body: {
      accessKeyId: "GK9",
      permissions: { owner: true, read: false, write: true },
    },
  });
  expect(JSON.stringify(post?.body)).not.toContain("bucketId");
  expect(calls.some((call) => call.url === "/api/buckets/a&b=c")).toBe(false);
  expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
    "/api/buckets/a%26b%3Dc",
    "/api/buckets/a%26b%3Dc",
  ]);
});

test("shows the API message when grant fails and keeps the entered values", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST") {
        return json({ message: "bucket key denied" }, 409);
      }
      return json({
        keys: [
          {
            accessKeyId: "GK1",
            name: "photos",
            permissions: { owner: false, read: true, write: false },
          },
        ],
      });
    }),
  );
  renderPermissions("bkt-1", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  expect(await screen.findByText("photos")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "GK9" } });
  fireEvent.click(screen.getByLabelText("Read"));
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
  expect(await screen.findByText("bucket key denied")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("GK9")).toBeNull();
  expect((screen.getByLabelText("Access key") as HTMLInputElement).value).toBe("GK9");
  expect((screen.getByLabelText("Read") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Owner") as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("photos")).toBeTruthy();
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    accessKeyId: "GK9",
    permissions: { owner: false, read: true, write: false },
  });
});

test("cancels a revoke without a request, then confirms with the key's current permissions", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      const gk1 = {
        accessKeyId: "GK1",
        name: "photos",
        permissions: { owner: true, read: false, write: true },
      };
      const gk2 = {
        accessKeyId: "GK2",
        name: "kept",
        permissions: { owner: false, read: true, write: false },
      };
      return json({
        keys: revoked ? [gk2] : [gk1, gk2],
      });
    }),
  );
  renderPermissions("a&b=c", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for a&b=c" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke GK1" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("GK1");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Revoke GK1" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Revoke GK1" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
  expect(await screen.findByText("kept")).toBeTruthy();
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Revoke GK1" })).toBeNull();
  });
  expect(screen.getByRole("button", { name: "Revoke GK2" })).toBeTruthy();
  expect(screen.queryByText("photos")).toBeNull();
  expect(calls.find((call) => call.method === "DELETE")).toEqual({
    url: "/api/buckets/a%26b%3Dc/permissions",
    method: "DELETE",
    credentials: "include",
    csrf: "csrf-token",
    body: {
      accessKeyId: "GK1",
      permissions: { owner: true, read: false, write: true },
    },
  });
  expect(JSON.stringify(calls.find((call) => call.method === "DELETE")?.body)).not.toContain("bucketId");
});

test("shows the API message when revoke fails and keeps the dialog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "DELETE") {
        return json({ message: "Cannot revoke" }, 409);
      }
      return json({
        keys: [
          {
            accessKeyId: "GK1",
            name: "photos",
            permissions: { owner: true, read: true, write: false },
          },
        ],
      });
    }),
  );
  renderPermissions("bkt-1", true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke GK1" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
  expect(await screen.findByText("Cannot revoke")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("GK1");
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke GK1" })).toBeTruthy();
});

test("a viewer sees the keys and does not call POST or DELETE", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.url.startsWith("/api/buckets?")) {
        return json({
          items: [{ id: "bkt-1", globalAliases: ["east"] }],
          hasMore: false,
        });
      }
      return json({
        keys: [
          {
            accessKeyId: "GK1",
            name: "photos",
            permissions: { owner: true, read: true, write: true },
          },
        ],
      });
    }),
  );
  renderBuckets(false);
  expect(await screen.findByRole("button", { name: "Permissions for bkt-1" })).toBeTruthy();
  expect(calls.every((call) => call.method === "GET" && call.url.startsWith("/api/buckets?"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Permissions for bkt-1" }));
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.getByText("owner yes")).toBeTruthy();
  expect(screen.getByText("read yes")).toBeTruthy();
  expect(screen.getByText("write yes")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke GK1" })).toBeNull();
  expect(screen.queryByLabelText("Access key")).toBeNull();
  expect(screen.queryByLabelText("Owner")).toBeNull();
  expect(calls.some((call) => call.url === "/api/buckets/bkt-1" && call.method === "GET")).toBe(true);
  expect(calls.some((call) => call.method === "POST" || call.method === "DELETE")).toBe(false);
});
