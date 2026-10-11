import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AdminTokens } from "./AdminTokens";
import { sectionFromHash } from "./Nav";

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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin-tokens") {
        return json([
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
        ]);
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
      if (url === "/api/admin-tokens") {
        return json([
          {
            id: "tok-issued-1a2b",
            name: "issued-reader",
            scope: ["ListBuckets"],
            expiration: "2026-12-01T00:00:00Z",
            expired: false,
            fromConfig: false,
            created: "2026-02-01T00:00:00Z",
          },
        ]);
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
  expect(
    screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent?.trim()),
  ).toEqual(["Never expires"]);
  expect(screen.queryByRole("checkbox", { name: "ListBuckets" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "GetClusterStatus" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "CreateAdminToken" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "*" } });
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
      if (url === "/api/admin-tokens") {
        return json([
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
        ]);
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
  expect((edit.getByLabelText("Scope") as HTMLInputElement).value).toBe("ListBuckets");
  expect(
    edit.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent?.trim()),
  ).toEqual(["Never expires"]);
  fireEvent.change(edit.getByLabelText("Scope"), { target: { value: "*" } });
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
      if (url === "/api/admin-tokens") {
        return json([
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
        ]);
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
