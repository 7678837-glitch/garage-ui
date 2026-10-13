import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AdminTokens } from "./AdminTokens";
import { sectionFromHash } from "./Nav";

const readFileSync = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs").readFileSync;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const UPSTREAM_ID = "tok-prefix-9f3a";
const SECRET = "fake-secret-9f3a";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function tokenPage(items: unknown[], hasMore = false) {
  return { items, hasMore };
}

function isTokenList(input: RequestInfo | URL, method: string): boolean {
  const url = new URL(String(input), "http://ui.local");
  return method === "GET" && url.pathname === "/api/admin-tokens";
}

function renderTokens() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminTokens />
    </QueryClientProvider>,
  );
}

function installApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      if (isTokenList(input, method)) {
        return json(
          tokenPage([
            {
              id: null,
              name: "config-reader",
              scope: ["GetClusterStatus", "Metrics"],
              expiration: null,
              expired: false,
              fromConfig: true,
              created: "2026-01-01T00:00:00Z",
              secretToken: SECRET,
            },
            {
              id: "tok-issued-1a2b",
              name: "issued-reader",
              scope: ["ListBuckets"],
              expiration: "2026-12-01T00:00:00Z",
              expired: true,
              fromConfig: false,
              created: "2026-02-01T00:00:00Z",
              secretToken: SECRET,
            },
          ]),
        );
      }
      if (url === "/api/admin-tokens/current") {
        return json({
          id: UPSTREAM_ID,
          name: "this-server-reader",
          scope: ["GetClusterHealth", "ListKeys"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
          secretToken: SECRET,
        });
      }
      return json({ message: "missing" }, 404);
    }),
  );
}

test("sectionFromHash sends an admin to tokens and a viewer to overview", () => {
  expect(sectionFromHash("#tokens", "admin")).toBe("tokens");
  expect(sectionFromHash("#tokens", "viewer")).toBe("overview");
});

test("a config row shows the configuration label and a created row does not", async () => {
  installApi();
  renderTokens();
  const config = await screen.findByRole("row", { name: /config-reader/ });
  expect(config.textContent).toContain("From configuration file");
  const created = screen.getByRole("row", { name: /issued-reader/ });
  expect(created.textContent).not.toContain("From configuration file");
});

test("the current block shows its scope and hides the upstream id and the secret", async () => {
  installApi();
  renderTokens();
  const block = await screen.findByRole("region", { name: "This server" });
  expect(block.textContent).toContain("GetClusterHealth, ListKeys");
  expect(block.textContent).not.toContain(UPSTREAM_ID);
  expect(block.textContent).not.toContain(SECRET);
});

test("a name filter hides the other row", async () => {
  installApi();
  renderTokens();
  await screen.findByRole("row", { name: /config-reader/ });
  fireEvent.change(screen.getByLabelText("Filter admin tokens"), { target: { value: "issued" } });
  expect(screen.queryByRole("row", { name: /config-reader/ })).toBeNull();
  expect(screen.getByRole("row", { name: /issued-reader/ })).toBeTruthy();
});

test("the page text does not contain the secret field name or the secret", async () => {
  installApi();
  renderTokens();
  await screen.findByRole("heading", { name: "Admin tokens" });
  await screen.findByText("this-server-reader");
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("secretToken");
  expect(text).not.toContain(SECRET);
});

const CREATED_SECRET = "created-token-secret-9f3a";

test("an admin creates a token, sees a full-admin scope warning, and the secret leaves the page", async () => {
  const calls: { method: string; url: string; confirm: string | null; body: unknown }[] = [];
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      const raw = init?.body;
      calls.push({
        method,
        url,
        confirm: headers.get("x-confirm"),
        body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
      });
      if (method === "POST" && url === "/api/admin-tokens") {
        return json({
          id: "tok-new",
          name: "reader",
          secretToken: CREATED_SECRET,
          scope: ["*"],
          expired: false,
        });
      }
      if (isTokenList(input, method)) {
        return json(
          tokenPage([
            {
              id: "tok-issued-1a2b",
              name: "issued-reader",
              scope: ["ListBuckets"],
              expiration: "2026-12-01T00:00:00Z",
              expired: false,
              fromConfig: false,
              created: "2026-02-01T00:00:00Z",
            },
          ]),
        );
      }
      if (url === "/api/admin-tokens/current") {
        return json({
          name: "this-server-reader",
          scope: ["GetClusterHealth"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
        });
      }
      return json({ message: "missing" }, 404);
    }),
  );
  renderTokens();
  expect(screen.getByRole("checkbox", { name: "Never expires" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "ListBuckets" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "GetClusterStatus" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "CreateAdminToken" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "All" }));
  expect(screen.getByText("This scope is equivalent to full admin access.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  const confirm = screen.getByRole("dialog");
  expect(confirm.textContent).toContain("The secret is shown once. It cannot be viewed again.");
  expect(confirm.textContent).toContain("*");
  fireEvent.change(screen.getByLabelText("Type reader to confirm"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  const field = (await screen.findByLabelText("Secret")) as HTMLInputElement;
  expect(field.type).toBe("password");
  expect(document.body.textContent ?? "").not.toContain(CREATED_SECRET);
  const posted = calls.find((call) => call.method === "POST");
  expect(posted).toEqual({
    method: "POST",
    url: "/api/admin-tokens",
    confirm: "yes",
    body: { name: "reader", scope: ["*"] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
  expect(field.type).toBe("text");
  expect(field.value).toBe(CREATED_SECRET);
  fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
  expect(await screen.findByText("Copied")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.textContent ?? "").not.toContain(CREATED_SECRET);
  for (const node of document.querySelectorAll("input, textarea")) {
    expect((node as HTMLInputElement).value).not.toContain(CREATED_SECRET);
  }
});

test("an admin updates an issued token and the response secret stays off the page", async () => {
  const issuedId = "tok-issued-1a2b";
  const calls: { method: string; url: string; confirm: string | null; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      const raw = init?.body;
      calls.push({
        method,
        url,
        confirm: headers.get("x-confirm"),
        body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
      });
      if (method === "PATCH" && url.startsWith("/api/admin-tokens/")) {
        return json({
          name: "renamed-reader",
          scope: ["*"],
          secretToken: SECRET,
        });
      }
      if (isTokenList(input, method)) {
        return json(
          tokenPage([
            {
              id: null,
              name: "config-reader",
              scope: ["GetClusterStatus", "Metrics"],
              expiration: null,
              expired: false,
              fromConfig: true,
              created: "2026-01-01T00:00:00Z",
              secretToken: SECRET,
            },
            {
              id: issuedId,
              name: "issued-reader",
              scope: ["ListBuckets"],
              expiration: "2026-12-01T00:00:00Z",
              expired: true,
              fromConfig: false,
              created: "2026-02-01T00:00:00Z",
              secretToken: SECRET,
            },
          ]),
        );
      }
      if (url === "/api/admin-tokens/current") {
        return json({
          id: UPSTREAM_ID,
          name: "this-server-reader",
          scope: ["GetClusterHealth", "ListKeys"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
          secretToken: SECRET,
        });
      }
      return json({ message: "missing" }, 404);
    }),
  );
  renderTokens();
  const config = await screen.findByRole("row", { name: /config-reader/ });
  expect(within(config).queryByRole("button", { name: "Edit" })).toBeNull();
  const issued = screen.getByRole("row", { name: /issued-reader/ });
  expect(within(issued).getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  expect(
    within(screen.getByRole("region", { name: "This server" })).queryByRole("button"),
  ).toBeNull();
  expect(document.body.textContent ?? "").not.toContain(issuedId);
  expect(window.location.href).not.toContain(issuedId);

  fireEvent.click(within(issued).getByRole("button", { name: "Edit" }));
  const update = screen.getByRole("button", { name: "Update token" });
  const form = update.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("missing edit form");
  }
  const edit = within(form);
  expect((edit.getByLabelText("Name") as HTMLInputElement).value).toBe("issued-reader");
  expect((edit.getByRole("checkbox", { name: "ListBuckets" }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect((edit.getByRole("checkbox", { name: "Never expires" }) as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(edit.getByRole("checkbox", { name: "All" }));
  expect(edit.getByText("This scope is equivalent to full admin access.")).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain(issuedId);
  fireEvent.change(edit.getByLabelText("Name"), { target: { value: "renamed-reader" } });
  fireEvent.click(update);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("This replaces the token name, expiration, and scope.");
  expect(dialog.textContent).toContain("*");
  fireEvent.change(screen.getByLabelText("Type issued-reader to confirm"), {
    target: { value: "issued-reader" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => {
    expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    expect(screen.queryByRole("button", { name: "Update token" })).toBeNull();
  });
  const patched = calls.find((call) => call.method === "PATCH");
  expect(patched?.url).toContain(`/api/admin-tokens/${issuedId}`);
  expect(patched?.confirm).toBe("yes");
  expect(patched?.body).toMatchObject({ name: "renamed-reader", scope: ["*"] });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  const text = document.body.textContent ?? "";
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(issuedId);
  expect(window.location.href).not.toContain(issuedId);
  for (const node of document.querySelectorAll("input, textarea")) {
    expect((node as HTMLInputElement).value).not.toContain(SECRET);
    expect((node as HTMLInputElement).value).not.toContain(issuedId);
  }
});

test("an admin deletes an issued token and the response secret stays off the page", async () => {
  const issuedId = "tok-issued-1a2b";
  const calls: { method: string; url: string; confirm: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      calls.push({
        method,
        url,
        confirm: headers.get("x-confirm"),
      });
      if (method === "DELETE" && url.startsWith("/api/admin-tokens/")) {
        return json({
          name: "issued-reader",
          secretToken: SECRET,
        });
      }
      if (isTokenList(input, method)) {
        return json(
          tokenPage([
            {
              id: null,
              name: "config-reader",
              scope: ["GetClusterStatus", "Metrics"],
              expiration: null,
              expired: false,
              fromConfig: true,
              created: "2026-01-01T00:00:00Z",
              secretToken: SECRET,
            },
            {
              id: issuedId,
              name: "issued-reader",
              scope: ["ListBuckets"],
              expiration: "2026-12-01T00:00:00Z",
              expired: true,
              fromConfig: false,
              created: "2026-02-01T00:00:00Z",
              secretToken: SECRET,
            },
          ]),
        );
      }
      if (url === "/api/admin-tokens/current") {
        return json({
          id: UPSTREAM_ID,
          name: "this-server-reader",
          scope: ["GetClusterHealth", "ListKeys"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
          secretToken: SECRET,
        });
      }
      return json({ message: "missing" }, 404);
    }),
  );
  renderTokens();
  const config = await screen.findByRole("row", { name: /config-reader/ });
  expect(within(config).queryByRole("button", { name: "Delete" })).toBeNull();
  const issued = screen.getByRole("row", { name: /issued-reader/ });
  expect(within(issued).getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  const server = await screen.findByRole("region", { name: "This server" });
  expect(within(server).queryByRole("button", { name: "Delete" })).toBeNull();
  expect(document.body.textContent ?? "").not.toContain(issuedId);
  expect(window.location.href).not.toContain(issuedId);

  fireEvent.click(within(issued).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("issued-reader");
  expect(dialog.textContent).toContain("This deletes the admin token.");
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  expect(document.body.textContent ?? "").not.toContain(issuedId);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => {
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const deleted = calls.find((call) => call.method === "DELETE");
  expect(deleted?.url).toBe(`/api/admin-tokens/${issuedId}`);
  expect(deleted?.confirm).toBeNull();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  const text = document.body.textContent ?? "";
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(issuedId);
  expect(window.location.href).not.toContain(issuedId);
  for (const node of document.querySelectorAll("input, textarea")) {
    expect((node as HTMLInputElement).value).not.toContain(SECRET);
    expect((node as HTMLInputElement).value).not.toContain(issuedId);
  }
});

test("turns admin token pages by 100 and keeps the filter, sort, and hash", async () => {
  window.history.replaceState(null, "", "/?tokens=reader&tokensSort=created#tokens/stay");
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/admin-tokens/current") {
        return json({
          name: "this-server-reader",
          scope: ["GetClusterHealth"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
        });
      }
      calls.push(`${url.pathname}${url.search}`);
      const offset = Number(url.searchParams.get("offset"));
      if (offset === 100) {
        return json(
          tokenPage(
            [
              {
                id: "tok-next",
                name: "later-reader",
                scope: ["ListKeys"],
                expiration: null,
                expired: false,
                fromConfig: false,
                created: "2026-04-01T00:00:00Z",
              },
            ],
            false,
          ),
        );
      }
      return json(
        tokenPage(
          [
            {
              id: null,
              name: "config-reader",
              scope: ["GetClusterStatus"],
              expiration: null,
              expired: false,
              fromConfig: true,
              created: "2026-01-01T00:00:00Z",
            },
          ],
          true,
        ),
      );
    }),
  );
  renderTokens();
  expect(await screen.findByRole("row", { name: /config-reader/ })).toBeTruthy();
  expect(calls[0]).toBe("/api/admin-tokens?offset=0&limit=100");
  expect(window.location.search).not.toContain("tokensOffset");
  const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
  const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  expect(previous.className).toBe("border border-neutral-900 px-3 py-1 text-left");
  expect(next.className).toBe("border border-neutral-900 px-3 py-1 text-left");
  fireEvent.click(next);
  expect(await screen.findByRole("row", { name: /later-reader/ })).toBeTruthy();
  expect(screen.queryByRole("row", { name: /config-reader/ })).toBeNull();
  expect(calls[1]).toBe("/api/admin-tokens?offset=100&limit=100");
  expect(window.location.search).toContain("tokensOffset=100");
  expect(window.location.search).toContain("tokens=reader");
  expect(window.location.search).toContain("tokensSort=created");
  expect(window.location.hash).toBe("#tokens/stay");
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(await screen.findByRole("row", { name: /config-reader/ })).toBeTruthy();
  expect(window.location.search).not.toContain("tokensOffset");
  expect(window.location.hash).toBe("#tokens/stay");
});

test("an unrecognized tokensOffset stays on the first page and does not rewrite the address", async () => {
  window.history.replaceState(null, "", "/?tokensOffset=nope&tokens=reader#tokens/stay");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/admin-tokens/current") {
        return json({
          name: "this-server-reader",
          scope: ["GetClusterHealth"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
        });
      }
      expect(url.pathname).toBe("/api/admin-tokens");
      expect(url.search).toBe("?offset=0&limit=100");
      return json(
        tokenPage([
          {
            id: null,
            name: "config-reader",
            scope: ["GetClusterStatus"],
            expiration: null,
            expired: false,
            fromConfig: true,
            created: "2026-01-01T00:00:00Z",
          },
        ]),
      );
    }),
  );
  renderTokens();
  expect(await screen.findByRole("row", { name: /config-reader/ })).toBeTruthy();
  expect(window.location.search).toBe("?tokensOffset=nope&tokens=reader");
  expect(window.location.hash).toBe("#tokens/stay");
});

const SCOPE_GROUPS: { name: string; endpoints: string[] }[] = [
  {
    name: "Cluster",
    endpoints: [
      "ConnectClusterNodes",
      "GetClusterHealth",
      "GetClusterStatistics",
      "GetClusterStatus",
      "Metrics",
    ],
  },
  {
    name: "Node",
    endpoints: ["CreateMetadataSnapshot", "GetNodeInfo", "GetNodeStatistics"],
  },
  {
    name: "Layout",
    endpoints: [
      "ApplyClusterLayout",
      "ClusterLayoutSkipDeadNodes",
      "GetClusterLayout",
      "GetClusterLayoutHistory",
      "PreviewClusterLayoutChanges",
      "RevertClusterLayout",
      "UpdateClusterLayout",
    ],
  },
  {
    name: "Bucket",
    endpoints: [
      "AddBucketAlias",
      "CleanupIncompleteUploads",
      "CreateBucket",
      "DeleteBucket",
      "GetBucketInfo",
      "InspectObject",
      "ListBuckets",
      "RemoveBucketAlias",
      "UpdateBucket",
    ],
  },
  {
    name: "Key",
    endpoints: ["CreateKey", "DeleteKey", "GetKeyInfo", "ImportKey", "ListKeys", "UpdateKey"],
  },
  {
    name: "Permission",
    endpoints: ["AllowBucketKey", "DenyBucketKey"],
  },
  {
    name: "Worker",
    endpoints: [
      "GetWorkerInfo",
      "GetWorkerVariable",
      "LaunchRepairOperation",
      "ListWorkers",
      "SetWorkerVariable",
    ],
  },
  {
    name: "Block",
    endpoints: ["GetBlockInfo", "ListBlockErrors", "PurgeBlocks", "RetryBlockResync"],
  },
  {
    name: "Admin token",
    endpoints: [
      "CreateAdminToken",
      "DeleteAdminToken",
      "GetAdminTokenInfo",
      "GetCurrentAdminTokenInfo",
      "ListAdminTokens",
      "UpdateAdminToken",
    ],
  },
];

function operationIds(specText: string): string[] {
  const spec = JSON.parse(specText) as { paths?: Record<string, unknown> };
  const names: string[] = [];
  for (const item of Object.values(spec.paths ?? {})) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    for (const operation of Object.values(item)) {
      if (typeof operation !== "object" || operation === null || !("operationId" in operation)) {
        continue;
      }
      const id = (operation as { operationId?: unknown }).operationId;
      if (typeof id === "string") {
        names.push(id);
      }
    }
  }
  return names;
}

function checkedBox(name: string): boolean {
  return (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;
}

test("scope_groups_cover_every_v24_admin_endpoint", async () => {
  const names = operationIds(readFileSync("../openapi/garage-admin-v2.json", "utf8"));
  const excluded = new Set(["CheckDomain", "Health"]);
  const endpoints = [...new Set(names.filter((id) => !excluded.has(id)))].sort();
  const grouped = SCOPE_GROUPS.flatMap((group) => group.endpoints).sort();
  expect(endpoints).toHaveLength(47);
  expect(endpoints.filter((id) => id !== "Metrics")).toHaveLength(46);
  expect(grouped).toEqual(endpoints);
  expect(names.filter((id) => id === "CheckDomain" || id === "Health")).toHaveLength(2);

  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = String(input);
      const raw = init?.body;
      calls.push({
        method,
        url,
        body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
      });
      if (method === "POST" && url === "/api/admin-tokens") {
        return json({
          id: "tok-new",
          name: "reader",
          secretToken: "created-token-secret-9f3a",
          scope: ["CreateAdminToken", "GetClusterStatus", "ListBuckets"],
          expired: false,
        });
      }
      if (isTokenList(input, method)) {
        return json(tokenPage([]));
      }
      if (url === "/api/admin-tokens/current") {
        return json({
          name: "this-server-reader",
          scope: ["GetClusterHealth"],
          expiration: null,
          expired: false,
          fromConfig: false,
          created: "2026-03-01T00:00:00Z",
        });
      }
      return json({ message: "missing" }, 404);
    }),
  );
  renderTokens();

  for (const id of endpoints) {
    expect(screen.getByRole("checkbox", { name: id })).toBeTruthy();
  }
  expect(screen.queryByRole("checkbox", { name: "CheckDomain" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Health" })).toBeNull();

  fireEvent.click(screen.getByRole("checkbox", { name: "Cluster" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Bucket" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Cluster" }));
  const bucketOnly = new Set(SCOPE_GROUPS.find((group) => group.name === "Bucket")?.endpoints);
  for (const id of endpoints) {
    expect([id, checkedBox(id)]).toEqual([id, bucketOnly.has(id)]);
  }
  expect(checkedBox("Cluster")).toBe(false);
  expect(checkedBox("Bucket")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Bucket" }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Cluster" }));
  const cluster = new Set(SCOPE_GROUPS[0].endpoints);
  for (const id of endpoints) {
    expect([id, checkedBox(id)]).toEqual([id, cluster.has(id)]);
  }
  for (const group of SCOPE_GROUPS) {
    expect([group.name, checkedBox(group.name)]).toEqual([group.name, group.name === "Cluster"]);
  }
  expect(checkedBox("All")).toBe(false);

  fireEvent.click(screen.getByRole("checkbox", { name: "All" }));
  expect(screen.getByText("This scope is equivalent to full admin access.")).toBeTruthy();
  for (const id of endpoints) {
    expect([id, checkedBox(id)]).toEqual([id, true]);
  }
  expect(checkedBox("All")).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  const fullDialog = screen.getByRole("dialog");
  expect(fullDialog.textContent).toContain("*");
  fireEvent.change(screen.getByLabelText("Type reader to confirm"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => {
    expect(calls.some((call) => call.method === "POST")).toBe(true);
  });
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    name: "reader",
    scope: ["*"],
  });
  fireEvent.click(await screen.findByRole("button", { name: "I have saved it" }));
  expect(screen.queryByText("This scope is equivalent to full admin access.")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "CreateAdminToken" }));
  expect(screen.getByText("This scope is equivalent to full admin access.")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "ListBuckets" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "GetClusterStatus" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  fireEvent.change(screen.getByLabelText("Type reader to confirm"), { target: { value: "reader" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
  expect(calls.filter((call) => call.method === "POST")[1]?.body).toEqual({
    name: "reader",
    scope: ["CreateAdminToken", "GetClusterStatus", "ListBuckets"],
  });
});

test("shows the API code and requests the admin token list again from Retry", async () => {
  let listCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(init?.credentials).toBe("include");
      if (url.pathname === "/api/admin-tokens/current") {
        return json({
          id: "tok-current",
          name: "server-token",
          scope: ["ListBuckets"],
          expiration: "2026-12-01T00:00:00Z",
          expired: false,
          fromConfig: false,
          created: "2026-02-01T00:00:00Z",
        });
      }
      expect(url.pathname).toBe("/api/admin-tokens");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("100");
      listCalls += 1;
      if (listCalls === 1) {
        return json({ code: "upstream_failed", message: "Garage returned an error" }, 502);
      }
      return json(
        tokenPage([
          {
            id: "tok-issued",
            name: "issued-reader",
            scope: ["ListBuckets"],
            expiration: "2026-12-01T00:00:00Z",
            expired: false,
            fromConfig: false,
            created: "2026-03-01T00:00:00Z",
          },
        ]),
      );
    }),
  );
  renderTokens();
  expect((await screen.findByText("Garage returned an error")).textContent).toBe(
    "Garage returned an error",
  );
  expect(screen.getByText("upstream_failed").textContent).toBe("upstream_failed");
  expect(screen.getByRole("button", { name: "Retry" }).textContent).toBe("Retry");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect((await screen.findByText("issued-reader")).textContent).toBe("issued-reader");
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(listCalls).toBe(2);
});
