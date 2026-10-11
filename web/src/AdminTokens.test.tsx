import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
