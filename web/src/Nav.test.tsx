import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const adminEntries = [
  "Overview",
  "Buckets",
  "Keys",
  "Nodes and layout",
  "Workers",
  "Block errors",
  "Users",
  "Admin tokens",
  "Audit",
  "Settings",
];

const viewerEntries = ["Overview", "Buckets", "Keys", "Settings"];

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

function sectionsNav() {
  return within(screen.getByRole("navigation", { name: "Sections" }));
}

function session(role: "admin" | "viewer") {
  const admin = role === "admin";
  return {
    initialized: true,
    authenticated: true,
    username: admin ? "Ada" : "Bea",
    role,
    can_download: admin,
    can_share: admin,
    garage_version: "v2.4.1",
    garage_write_blocked: false,
  };
}

function stubSignedIn(role: "admin" | "viewer") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return new Response(
        JSON.stringify({
          version: "20261010.1",
          listBucketsInfo: "unknown",
          listKeysInfo: "unknown",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/auth/status")) {
      return new Response(JSON.stringify(session(role)), { status: 200 });
    }
    if (url.includes("/healthz")) {
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }
    if (url.includes("/api/cluster/status")) {
      return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
    }
    if (url.includes("/api/cluster/health") || url.includes("/api/cluster/statistics")) {
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    }
    if (url.includes("/api/buckets") || url.includes("/api/keys")) {
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    }
    if (url.includes("/api/users")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function linkNames() {
  return sectionsNav()
    .getAllByRole("link")
    .map((link) => link.textContent);
}

test("an admin sees Overview through Settings in order and no undelivered pages", async () => {
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByText("Ada · admin")).toBeTruthy();
  expect(linkNames()).toEqual(adminEntries);
  expect(sectionsNav().queryByRole("link", { name: "Operations" })).toBeNull();
});

test("a viewer does not see Nodes and layout, Admin tokens, or Users", async () => {
  const fetchMock = stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(linkNames()).toEqual(viewerEntries);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
});

test("a viewer opening #nodes stays on overview and an admin marks Nodes and layout current", async () => {
  window.location.hash = "#nodes";
  const fetchMock = stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  const viewerCrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(viewerCrumb).getByText("Overview", { selector: "[aria-current='page']" })).toBeTruthy();
  expect(sectionsNav().queryByRole("link", { name: "Nodes and layout" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(window.location.hash).toBe("#nodes");
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );

  cleanup();
  window.location.hash = "#nodes";
  stubSignedIn("admin");
  renderApp();
  const nodes = await screen.findByRole("link", { name: "Nodes and layout" });
  expect(nodes.getAttribute("aria-current")).toBe("page");
  expect(nodes.getAttribute("href")).toBe("#nodes");
});

test("settings shows About and the password form, and overview does not", async () => {
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("Bea · viewer")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Settings" }));
  expect(window.location.hash).toBe("#settings");
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getByLabelText("Current password")).toBeTruthy();
  expect(screen.getByLabelText("New password")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(2);
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
});

test("nodes and layout is its own admin page and is absent from overview", async () => {
  const fetchMock = stubSignedIn("admin");
  renderApp();
  expect(await screen.findByText("Ada · admin")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Cluster health" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );

  fireEvent.click(sectionsNav().getByRole("link", { name: "Nodes and layout" }));
  expect(window.location.hash).toBe("#nodes");
  expect(await screen.findByRole("heading", { name: "Nodes" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.getByRole("link", { name: "Nodes and layout" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    true,
  );
});

test("the top bar keeps a health status badge when the section changes", async () => {
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("ok · test")).toBeTruthy();
  const badge = screen.getByRole("status", { name: "Health status" });
  expect(badge.textContent).toBe("ok · test");
  const version = screen.getByText("Garage v2.4.1");
  const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(version.closest(".console-health")).toBeTruthy();
  expect(crumb.closest("header")).toBeTruthy();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Keys" }));
  expect(await screen.findByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Health status" }).textContent).toBe("ok · test");
  expect(screen.getByText("Garage v2.4.1").closest(".console-health")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Breadcrumb" }).closest("header")).toBeTruthy();
});

function mobileViewport() {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

test("mobile navigation is a labelled modal and Escape returns focus to Menu", async () => {
  mobileViewport();
  stubSignedIn("viewer");
  renderApp();
  await screen.findByText("Bea · viewer");
  const menu = screen.getByRole("button", { name: "Menu" });
  menu.focus();
  fireEvent.click(menu);
  const drawer = screen.getByRole("dialog", { name: "Sections" });
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(drawer.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(drawer, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Sections" })).toBeNull();
  expect(document.activeElement).toBe(menu);
});

test("mobile navigation stays open on rejected dirty leave and closes on accepted leave", async () => {
  mobileViewport();
  window.location.hash = "#settings";
  stubSignedIn("viewer");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp();
  await screen.findByText("Bea · viewer");
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "dirty" } });
  const menu = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(menu);
  fireEvent.click(sectionsNav().getByRole("link", { name: "Keys" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(window.location.hash).toBe("#settings");
  expect(screen.getByRole("dialog", { name: "Sections" })).toBeTruthy();
  confirm.mockReturnValue(true);
  fireEvent.click(sectionsNav().getByRole("link", { name: "Keys" }));
  await waitFor(() => expect(window.location.hash).toBe("#keys"));
  expect(screen.queryByRole("dialog", { name: "Sections" })).toBeNull();
  expect(document.activeElement).toBe(menu);
});
