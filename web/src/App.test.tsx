import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App, decodeObjectKey, encodeObjectKey, folderNameAllowed } from "./App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

async function chooseSection(name: string) {
  fireEvent.click(await screen.findByRole("link", { name }));
}

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

function capabilitiesResponse() {
  return new Response(
    JSON.stringify({
      version: "20261010.1",
      listBucketsInfo: "unknown",
      listKeysInfo: "unknown",
    }),
    { status: 200 },
  );
}

test("shows health status when the session is authenticated", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getByText("Garage version is not set")).toBeTruthy();
  expect(setItem).not.toHaveBeenCalled();
});

test("shows the setup form before initialization and does not use storage", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
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

test("shows why a short setup password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
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
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows why a short login password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    return new Response(
      JSON.stringify({
        initialized: true,
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
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows why a short new password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
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
  fireEvent.change(await screen.findByLabelText("Current password"), {
    target: { value: "current secret" },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows a blocking notice when Garage is older than v2.3.0", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe("Garage v2.3.0 or newer is required");
  expect(screen.getByText("Ada · admin")).toBeTruthy();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(1);
  await chooseSection("Keys");
  expect(await screen.findByText("Keys are unavailable")).toBeTruthy();
});

test("shows user management for an admin and locks that signed-in row", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getByText("Garage v2.4.1")).toBeTruthy();
  await chooseSection("Users");
  const remove = (await screen.findByRole("button", { name: "Delete Ada" })) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Role for Ada" }) as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("checkbox", { name: "Disabled for Ada" }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(document.body.textContent).not.toContain("$2b$12$from-the-api");
});

test("hides user management from a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
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
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getByText("Garage v2.4.1")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
});

test("shows a bucket id and its alias to an admin", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  await chooseSection("Buckets");
  expect(await screen.findByText("bucket-ada")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  await chooseSection("Users");
  expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy();
  await chooseSection("Keys");
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByText("ada-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Rename key-ada" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete key-ada" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "View secret for key-ada" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Allow create bucket for key-ada" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETADA");
});

test("shows a bucket id to a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
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
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  await chooseSection("Buckets");
  expect(await screen.findByText("bucket-bea")).toBeTruthy();
  expect(screen.getByText("west")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete bucket-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add alias to bucket-bea" })).toBeNull();
  await chooseSection("Keys");
  expect(await screen.findByText("key-bea")).toBeTruthy();
  expect(screen.getByText("bea-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETBEa");
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/keys"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename key-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete key-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "View secret for key-bea" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Allow create bucket for key-bea" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter((call) => {
      const method = methodOf(call).toUpperCase();
      return method !== "GET" && String(call[0]).includes("/api/keys");
    }),
  ).toEqual([]);
  expect(
    fetchMock.mock.calls.filter((call) => {
      const method = methodOf(call).toUpperCase();
      return method !== "GET" && String(call[0]).includes("/api/buckets");
    }),
  ).toEqual([]);
});

function sessionResponse(role: "admin" | "viewer") {
  const admin = role === "admin";
  return new Response(
    JSON.stringify({
      initialized: true,
      authenticated: true,
      username: admin ? "Ada" : "Bea",
      role,
      can_download: admin,
      can_share: admin,
      garage_version: "v2.4.1",
      garage_write_blocked: false,
    }),
    { status: 200 },
  );
}

function stubSignedIn(role: "admin" | "viewer") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/status")) {
        return sessionResponse(role);
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "bucket-ada", globalAliases: ["pictures"] }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/keys")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "key-ada", name: "ada-key" }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/users")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
}

test("the Buckets nav action sets exactly #buckets", async () => {
  window.location.hash = "#buckets/bucket-ada/photos/2024/";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("button", { name: "Back to buckets" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  await chooseSection("Buckets");
  expect(window.location.hash).toBe("#buckets");
  expect(await screen.findByRole("button", { name: "Create bucket" })).toBeTruthy();
  expect(screen.getByText("bucket-ada")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back to buckets" })).toBeNull();
});

test("choosing Keys hides the buckets section and sets the hash", async () => {
  window.location.hash = "#buckets";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByText("bucket-ada")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Buckets" })).toBeTruthy();
  await chooseSection("Keys");
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.queryByText("bucket-ada")).toBeNull();
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(window.location.hash).toBe("#keys");
});

test("loading #keys shows keys", async () => {
  window.location.hash = "#keys";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.queryByText("Bea · viewer")).toBeNull();
});

test("an admin sees Users and a viewer opening #users sees overview", async () => {
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("link", { name: "Users" })).toBeTruthy();
  cleanup();

  window.location.hash = "#users";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
});

test("a non-admin #users/x stays on overview and keeps the hash", async () => {
  window.location.hash = "#users/x";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(window.location.hash).toBe("#users/x");
});

test("an unknown hash shows overview", async () => {
  window.location.hash = "#layout";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByText("Ada · admin")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Keys" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
});

test("Menu toggles the links", async () => {
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("link", { name: "Overview" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Buckets" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Keys" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.queryByRole("link", { name: "Overview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Buckets" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Keys" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  await chooseSection("Keys");
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(window.location.hash).toBe("#keys");
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

function objectBrowserResponse(role: "admin" | "viewer", canDownload: boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: role === "admin" ? "Ada" : "Bea",
          role,
          can_download: canDownload,
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
    if (url.includes("/objects/a.txt")) {
      return new Response(
        JSON.stringify({
          key: "a.txt",
          size: 1,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/objects")) {
      return new Response(
        JSON.stringify({
          prefix: "",
          entries: [
            { kind: "prefix", prefix: "photos/" },
            {
              kind: "object",
              key: "a.txt",
              size: 1,
              etag: "abc",
              lastModified: "2026-10-11T00:00:00Z",
            },
          ],
          next: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/buckets")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "bucket-bea", globalAliases: ["west"] }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
}

test("a viewer without download does not see preview or write controls", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("viewer", false));
  renderApp();
  expect(await screen.findByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.getByLabelText("Search")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  expect(await screen.findByText("text/plain")).toBeTruthy();
});

test("a viewer with download sees preview and download but not write controls", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("viewer", true));
  renderApp();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("link", { name: "Preview" }).getAttribute("href")).toBe(
    "/api/buckets/bucket-bea/objects/a.txt?preview=1",
  );
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    "/api/buckets/bucket-bea/objects/a.txt?download=1",
  );
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete folder" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
});

test("shows one Garage banner when the bucket list is down and clears it after Retry", async () => {
  window.location.hash = "#buckets";
  let bucketCalls = 0;
  let healthCalls = 0;
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
        healthCalls += 1;
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        bucketCalls += 1;
        if (bucketCalls === 1) {
          return new Response(
            JSON.stringify({
              code: "garage_unavailable",
              message: "Garage admin API is not reachable",
            }),
            { status: 502 },
          );
        }
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    }),
  );
  renderApp();
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage admin API is not reachable");
  const buckets = screen.getByRole("region", { name: "Buckets" });
  expect(buckets.textContent ?? "").not.toContain("garage_unavailable");
  expect(buckets.textContent ?? "").not.toContain("Garage admin API is not reachable");
  const bucketsBefore = bucketCalls;
  const healthBefore = healthCalls;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(bucketCalls).toBe(bucketsBefore + 1);
  expect(healthCalls).toBe(healthBefore);
});

test("keeps the Garage banner while a down bucket list refetch has not settled", async () => {
  window.location.hash = "#buckets";
  let bucketCalls = 0;
  let secondSettled = false;
  let releaseSecond: () => void = () => {};
  const secondResponse = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
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
      if (url.includes("/api/buckets")) {
        bucketCalls += 1;
        if (bucketCalls > 1) {
          await secondResponse;
          secondSettled = true;
        }
        return new Response(
          JSON.stringify({
            code: "garage_unavailable",
            message: "Garage admin API is not reachable",
          }),
          { status: 502 },
        );
      }
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    }),
  );
  renderApp();
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage admin API is not reachable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(bucketCalls).toBe(2);
    expect(screen.getByRole("alert").textContent).toBe("Garage admin API is not reachable");
  });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  releaseSecond();
  await waitFor(() => {
    expect(secondSettled).toBe(true);
    expect(screen.queryByText("Loading buckets")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Garage admin API is not reachable");
  });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  const buckets = screen.getByRole("region", { name: "Buckets" });
  expect(buckets.textContent ?? "").not.toContain("garage_unavailable");
});

test("an admin with the download bit off still sees upload, delete, preview, and download", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("admin", false));
  renderApp();
  expect(await screen.findByRole("button", { name: "Delete folder" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Upload" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Preview" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});
