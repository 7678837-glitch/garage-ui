import { GarageTheme } from "./theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe, { type AxeResults } from "axe-core";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import "./index.css";

const pages = [
  { link: "Overview", heading: "Cluster health", settled: "Known nodes" },
  { link: "Buckets", heading: "Buckets", settled: "There are no buckets. Create the first bucket." },
  { link: "Keys", heading: "Keys", settled: "There are no keys. Create the first key." },
  {
    link: "Nodes and layout",
    heading: "Nodes",
    settled: "There are no nodes. Connect the first node.",
  },
  { link: "Admin tokens", heading: "Admin tokens", settled: "No admin tokens" },
  { link: "Users", heading: "Users", settled: "There are no users. Create the first user." },
  { link: "Settings", heading: "About", settled: "Version 20261010.1" },
] as const;

const themes = ["Light", "Dark"] as const;

afterEach(() => {
  cleanup();
  window.location.hash = "";
  localStorage.clear();
  document.documentElement.className = "";
  document.title = "";
  document.documentElement.lang = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function responseFor(url: string): Response {
  if (url.includes("/api/auth/status")) {
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
  if (url.includes("/healthz")) {
    return json({ status: "ok", version: "test" });
  }
  if (url.includes("/api/capabilities")) {
    return json({
      version: "20261010.1",
      listBucketsInfo: "unknown",
      listKeysInfo: "unknown",
    });
  }
  if (url.includes("/api/cluster/health")) {
    return json({
      status: "healthy",
      knownNodes: 1,
      connectedNodes: 1,
      storageNodes: 1,
      storageNodesUp: 1,
      partitions: 1,
      partitionsQuorum: 1,
      partitionsAllOk: 1,
    });
  }
  if (url.includes("/api/cluster/statistics")) {
    return json({
      bucketCount: 0,
      totalObjectCount: 0,
      totalObjectBytes: 0,
      dataAvail: 0,
      metadataAvail: 0,
      incompleteAvailInfo: false,
    });
  }
  if (url.includes("/api/cluster/status")) {
    return json({ nodes: [] });
  }
  if (url.includes("/api/admin-tokens/current")) {
    return json({ id: "tok-1", name: "local", scope: [], expiration: "never" });
  }
  if (
    url.includes("/api/admin-tokens") ||
    url.includes("/api/buckets") ||
    url.includes("/api/keys") ||
    url.includes("/api/users")
  ) {
    return json({ items: [], hasMore: false });
  }
  return json({ message: `unmocked ${url}` }, 500);
}

function stubMatchMedia() {
  const media: MediaQueryList = {
    matches: false,
    media: "",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  };
  vi.stubGlobal("matchMedia", () => media);
}

function seriousViolations(results: AxeResults) {
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
}

function renderSignedIn() {
  document.title = "Garage UI";
  document.documentElement.lang = "en";
  stubMatchMedia();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => responseFor(String(input))),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GarageTheme><App /></GarageTheme>
    </QueryClientProvider>,
  );
}

for (const theme of themes) {
  for (const page of pages) {
    test(`${page.link} has no serious axe violations in ${theme}`, async () => {
      const view = renderSignedIn();
      fireEvent.click(await screen.findByRole("button", { name: theme }));
      expect(document.documentElement.classList.contains(theme.toLowerCase())).toBe(true);
      const nav = within(await screen.findByRole("navigation", { name: "Sections" }));
      fireEvent.click(await nav.findByRole("link", { name: page.link }));
      await screen.findByRole("heading", { name: page.heading });
      await screen.findByText(page.settled);
      const results = await axe.run(view.container);
      expect(seriousViolations(results)).toEqual([]);
    }, 20_000);
  }
}
