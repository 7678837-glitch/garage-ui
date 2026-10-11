import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { About } from "./About";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAbout(garageVersion: string | null | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <About garageVersion={garageVersion} />
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("shows the version and the three probe words unchanged", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        version: "20261010.1",
        listBucketsInfo: "unknown",
        listKeysInfo: "unknown",
      }),
    ),
  );
  renderAbout("v2.3.0");
  expect(await screen.findByRole("heading", { name: "About" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getByText("Garage v2.3.0")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        version: "20261010.1",
        listBucketsInfo: "present",
        listKeysInfo: "absent",
      }),
    ),
  );
  renderAbout("v2.4.1");
  expect(await screen.findByText("List buckets info present")).toBeTruthy();
  expect(screen.getByText("List keys info absent")).toBeTruthy();
  expect(screen.getByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("Garage v2.4.1")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("says the Garage version is not set when the session omits it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        version: "20261010.1",
        listBucketsInfo: "unknown",
        listKeysInfo: "present",
      }),
    ),
  );
  renderAbout(null);
  expect(await screen.findByText("Garage version is not set")).toBeTruthy();
  expect(await screen.findByText("List keys info present")).toBeTruthy();
  cleanup();
  renderAbout(undefined);
  expect(await screen.findByText("Garage version is not set")).toBeTruthy();
  expect(screen.queryByText("Garage v2.4.1")).toBeNull();
});

test("shows the API message and code, then loads capabilities again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/capabilities");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json(
          { code: "upstream_failed", message: "Garage returned an error" },
          502,
        );
      }
      return json({
        version: "20261010.1",
        listBucketsInfo: "absent",
        listKeysInfo: "unknown",
      });
    }),
  );
  renderAbout("v2.4.1");
  const paragraph = await screen.findByText("Garage returned an error upstream_failed");
  expect(paragraph.tagName).toBe("P");
  expect(paragraph.getAttribute("role")).toBeNull();
  expect(screen.getByText("Garage v2.4.1")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Version 20261010.1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info absent")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.queryByText("Garage returned an error upstream_failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});
