import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App, decodeObjectKey, encodeObjectKey, folderNameAllowed } from "./App";

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

test("shows health status when the session is authenticated", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
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
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(setItem).not.toHaveBeenCalled();
});

test("shows the setup form before initialization and does not use storage", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/setup")) {
      return new Response(JSON.stringify({ username: "Ada", role: "admin" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        initialized: false,
        authenticated: false,
        username: null,
        role: null,
        can_download: null,
        can_share: null,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setup",
      expect.objectContaining({ credentials: "include", method: "POST" }),
    );
  });
  expect(setItem).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(false);
});

test("shows a blocking notice when Garage is older than v2.3.0", async () => {
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
            garage_version: "v2.2.0",
            garage_write_blocked: true,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe("Garage v2.3.0 or newer is required");
  expect(screen.getByText("Ada · admin")).toBeTruthy();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(await screen.findByText("Keys are unavailable")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(1);
});

test("shows user management for an admin and locks that signed-in row", async () => {
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
      if (url.includes("/api/users")) {
        return new Response(
          JSON.stringify([
            {
              id: 7,
              username: "Ada",
              role: "admin",
              can_download: false,
              can_share: false,
              disabled: false,
              password_hash: "$2b$12$from-the-api",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  const remove = (await screen.findByRole("button", { name: "Delete Ada" })) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Role for Ada" }) as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("checkbox", { name: "Disabled for Ada" }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(document.body.textContent).not.toContain("$2b$12$from-the-api");
  expect(await screen.findByText("ok · test")).toBeTruthy();
});

test("hides user management from a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: "Bea",
          role: "viewer",
          can_download: false,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
});

test("shows a bucket id and its alias to an admin", async () => {
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
      if (url.includes("/api/users")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "bucket-ada", globalAliases: ["a&b=c"] }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/keys")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "key-ada", name: "ada-key", secretAccessKey: "SECRETADA" }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("bucket-ada")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy();
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByText("ada-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETADA");
});

test("shows a bucket id to a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: "Bea",
          role: "viewer",
          can_download: false,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/healthz")) {
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }
    if (url.includes("/api/buckets")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "bucket-bea", localAliases: ["west"] }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/keys")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "key-bea", name: "bea-key", secretAccessKey: "SECRETBEa" }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByText("bucket-bea")).toBeTruthy();
  expect(screen.getByText("west")).toBeTruthy();
  expect(screen.getByText("Bea · viewer")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(await screen.findByText("key-bea")).toBeTruthy();
  expect(screen.getByText("bea-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETBEa");
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/keys"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete bucket-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add alias to bucket-bea" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter((call) => {
      const method = methodOf(call).toUpperCase();
      return method !== "GET" && String(call[0]).includes("/api/buckets");
    }),
  ).toEqual([]);
});

function methodOf(call: readonly unknown[]): string {
  const init = call[1];
  if (typeof init !== "object" || init === null || !("method" in init)) {
    return "GET";
  }
  return typeof init.method === "string" ? init.method : "GET";
}

test("encodes each object key segment and allows the spec folder names", () => {
  expect(encodeObjectKey("a?b#c%20d=e")).toBe("a%3Fb%23c%2520d%3De");
  expect(decodeObjectKey("a%3Fb%23c%2520d%3De")).toBe("a?b#c%20d=e");
  expect(encodeObjectKey("报告.txt")).toBe("%E6%8A%A5%E5%91%8A.txt");
  expect(decodeObjectKey("%E6%8A%A5%E5%91%8A.txt")).toBe("报告.txt");
  expect(encodeObjectKey("dir/报告.txt")).toBe("dir/%E6%8A%A5%E5%91%8A.txt");
  expect(decodeObjectKey("dir/%E6%8A%A5%E5%91%8A.txt")).toBe("dir/报告.txt");
  expect(folderNameAllowed("a?b#c%20d=e")).toBe(true);
  expect(folderNameAllowed("报告.txt")).toBe(true);
  expect(folderNameAllowed("a b")).toBe(true);
  expect(folderNameAllowed("=#?% ")).toBe(true);
  expect(folderNameAllowed("a/b")).toBe(false);
  expect(folderNameAllowed("a\nb")).toBe(false);
  expect(folderNameAllowed("a\u0000b")).toBe(false);
});
