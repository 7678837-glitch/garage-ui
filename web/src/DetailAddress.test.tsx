import { GarageTheme } from "./theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { Buckets } from "./Buckets";
import { Keys } from "./Keys";

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
      <GarageTheme><App /></GarageTheme>
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stubSignedIn() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      if (url.pathname === "/api/auth/status") {
        return json({
          initialized: true,
          authenticated: true,
          username: "Ada",
          role: "admin",
          can_download: true,
          can_share: true,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        });
      }
      if (url.pathname === "/healthz") {
        return json({ status: "ok", version: "test" });
      }
      if (url.pathname === "/api/cluster/health" || url.pathname === "/api/cluster/statistics") {
        return json({ status: "healthy" });
      }
      if (url.pathname === "/api/cluster/status") {
        return json({ nodes: [] });
      }
      if (url.pathname === "/api/buckets" || url.pathname === "/api/keys") {
        return json({ items: [], hasMore: false });
      }
      if (url.pathname.startsWith("/api/buckets/")) {
        return json({ keys: [] });
      }
      return new Response("no", { status: 500 });
    }),
  );
}

function crumb() {
  return within(screen.getByRole("navigation", { name: "Breadcrumb" }));
}

function tablist(name: string) {
  return within(screen.getByRole("tablist", { name }));
}

test("a bucket, a key, and a node each open on the detail tab in the address", async () => {
  window.location.hash = "#bucket/a%26b/permissions";
  stubSignedIn();
  renderApp();

  const permissions = await screen.findByRole("tab", { name: "Permissions" });
  expect(permissions.getAttribute("aria-selected")).toBe("true");
  expect(permissions.getAttribute("href")).toBe("#bucket/a%26b/permissions");
  expect(window.location.hash).toBe("#bucket/a%26b/permissions");
  expect(tablist("Bucket a&b").getByRole("tab", { name: "Overview" }).getAttribute("href")).toBe(
    "#bucket/a%26b/overview",
  );
  expect(tablist("Bucket a&b").getByRole("tab", { name: "Objects" }).getAttribute("href")).toBe(
    "#bucket/a%26b/objects",
  );
  expect(tablist("Bucket a&b").getByRole("tab", { name: "Settings" }).getAttribute("href")).toBe(
    "#bucket/a%26b/settings",
  );
  expect(tablist("Bucket a&b").queryByRole("tab", { name: "Website" })).toBeNull();
  expect(tablist("Bucket a&b").queryByRole("tab", { name: "CORS" })).toBeNull();
  expect(tablist("Bucket a&b").queryByRole("tab", { name: "Lifecycle" })).toBeNull();
  expect(tablist("Bucket a&b").queryByRole("tab", { name: "Incomplete uploads" })).toBeNull();
  expect(crumb().getByText("Permissions", { selector: "[aria-current='page']" }).textContent).toBe(
    "Permissions",
  );
  expect(
    within(screen.getByRole("navigation", { name: "Sections" }))
      .getByRole("link", { name: "Buckets" })
      .getAttribute("aria-current"),
  ).toBe("page");

  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  expect(window.location.hash).toBe("#bucket/a%26b/overview");
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Permissions" }).getAttribute("aria-selected")).toBe(
    "false",
  );
  expect(
    (
      await crumb().findByText("Overview", { selector: "[aria-current='page']" })
    ).textContent,
  ).toBe("Overview");

  cleanup();
  window.location.hash = "#buckets/bkt-1/photos/2024/";
  renderApp();
  expect(await screen.findByRole("button", { name: "Ada · admin" })).toBeTruthy();
  expect(window.location.hash).toBe("#buckets/bkt-1/photos/2024/");
  expect(crumb().getByText("Objects", { selector: "[aria-current='page']" }).textContent).toBe(
    "Objects",
  );
  expect(screen.queryByRole("tablist", { name: "Bucket bkt-1" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "photos" })).toBeNull();

  cleanup();
  window.location.hash = "#key/GK1/buckets";
  renderApp();
  const buckets = await screen.findByRole("tab", { name: "Buckets" });
  expect(buckets.getAttribute("aria-selected")).toBe("true");
  expect(buckets.getAttribute("href")).toBe("#key/GK1/buckets");
  expect(window.location.hash).toBe("#key/GK1/buckets");
  expect(tablist("Key GK1").getByRole("tab", { name: "Overview" }).getAttribute("href")).toBe(
    "#key/GK1/overview",
  );
  expect(tablist("Key GK1").getByRole("tab", { name: "Settings" }).getAttribute("href")).toBe(
    "#key/GK1/settings",
  );
  expect(crumb().getByRole("link", { name: "Keys" }).getAttribute("href")).toBe("#keys");
  expect(crumb().getByText("Buckets", { selector: "[aria-current='page']" }).textContent).toBe(
    "Buckets",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
  expect(window.location.hash).toBe("#key/GK1/settings");
  expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");

  cleanup();
  window.location.hash = "#node/node-1/statistics";
  renderApp();
  const statistics = await screen.findByRole("tab", { name: "Statistics" });
  expect(statistics.getAttribute("aria-selected")).toBe("true");
  expect(statistics.getAttribute("href")).toBe("#node/node-1/statistics");
  expect(window.location.hash).toBe("#node/node-1/statistics");
  expect(
    tablist("Node node-1").getByRole("tab", { name: "Information" }).getAttribute("href"),
  ).toBe("#node/node-1/information");
  expect(
    tablist("Node node-1").getByRole("tab", { name: "Maintenance" }).getAttribute("href"),
  ).toBe("#node/node-1/maintenance");
  expect(tablist("Node node-1").queryByRole("tab", { name: "Workers" })).toBeNull();
  expect(tablist("Node node-1").queryByRole("tab", { name: "Block errors" })).toBeNull();
  expect(
    within(screen.getByRole("navigation", { name: "Sections" })).queryByRole("link", {
      name: "Operations",
    }),
  ).toBeNull();
  expect(
    within(screen.getByRole("navigation", { name: "Sections" }))
      .getByRole("link", { name: "Audit" })
      .getAttribute("href"),
  ).toBe("#audit");
  expect(crumb().getByRole("link", { name: "Nodes and layout" }).getAttribute("href")).toBe(
    "#nodes",
  );
  expect(crumb().getByText("Statistics", { selector: "[aria-current='page']" }).textContent).toBe(
    "Statistics",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Information" }));
  expect(window.location.hash).toBe("#node/node-1/information");
  expect(screen.getByRole("tab", { name: "Information" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByRole("tab", { name: "Statistics" }).getAttribute("aria-selected")).toBe(
    "false",
  );
});

function renderStorage(resource: "bucket" | "key") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><GarageTheme>{resource === "bucket" ? <Buckets canManage /> : <Keys canManage />}</GarageTheme></QueryClientProvider>);
}

test.each(["id", "accessKeyId"])("cold key settings load the addressed %s response beyond the first list page", async (idField) => {
  window.location.hash = "#key/GK101/settings";
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    if (url.pathname === "/api/keys") return json({ items: [{ id: "GK1", name: "first" }], hasMore: true });
    if (url.pathname === "/api/keys/GK101") return json({ [idField]: "GK101", name: "Addressed key", permissions: { createBucket: true }, buckets: [] });
    return json({ message: "Unexpected endpoint" }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  renderStorage("key");
  expect((await screen.findByRole("checkbox", { name: "Allow bucket creation (GK101)" })).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Actions (GK101)" }));
  expect((await within(screen.getByRole("dialog", { name: "Name" })).findByLabelText("Name for GK101") as HTMLInputElement).value).toBe("Addressed key");
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes("offset=")).length).toBe(1);
});

test("cold bucket settings load addressed quotas beyond the first list page without losing integer precision", async () => {
  window.location.hash = "#bucket/bkt101/settings";
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    if (url.pathname === "/api/buckets") return json({ items: [{ id: "bkt1" }], hasMore: true });
    if (url.pathname === "/api/buckets/bkt101") return new Response('{"id":"bkt101","quotas":{"maxSize":9007199254740993,"maxObjects":12}}');
    return json({ message: "Unexpected endpoint" }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  renderStorage("bucket");
  expect((await screen.findByLabelText("Max size for bkt101") as HTMLInputElement).value).toBe("9007199254740993");
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes("offset=")).length).toBe(1);
});

test.each([["bucket", 404], ["key", 404], ["bucket", 500], ["key", 500]] as const)("cold %s settings show loading, failure %i and retry", async (resource, status) => {
  window.location.hash = `#${resource}/missing/settings`;
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    if (url.pathname === `/api/${resource}s`) return json({ items: [], hasMore: false });
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  renderStorage(resource);
  expect(screen.getByLabelText(resource === "bucket" ? "Loading buckets" : "Loading keys")).toBeTruthy();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish?.(json({ message: "Resource unavailable", code: status === 404 ? "not_found" : "upstream_failed" }, status));
  expect(await screen.findByText("Resource unavailable")).toBeTruthy();
  expect(screen.getByText(status === 404 ? "not_found" : "upstream_failed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() => expect(screen.getByLabelText(resource === "bucket" ? "Loading buckets" : "Loading keys")).toBeTruthy());
});
