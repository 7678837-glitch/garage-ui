import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { GarageTheme } from "./theme";

const { loadWorkers } = vi.hoisted(() => ({ loadWorkers: vi.fn() }));

vi.mock("./Workers", () => {
  loadWorkers();
  return { Workers: () => <h2>Deferred workers page</h2> };
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

test("loads a section module only after an authenticated user opens that section", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/status") {
      return Response.json({ initialized: true, authenticated: true, username: "Ada", role: "admin" });
    }
    if (url === "/api/cluster/status") return Response.json({ nodes: [] });
    return Response.json({ status: "ok", version: "test" });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><GarageTheme><App /></GarageTheme></QueryClientProvider>);

  const navigation = within(await screen.findByRole("navigation", { name: "Sections" }));
  expect(loadWorkers).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Deferred workers page" })).toBeNull();
  fireEvent.click(navigation.getByRole("link", { name: "Workers" }));
  expect(screen.getByText("Loading Workers…").getAttribute("role")).toBe("status");
  expect(await screen.findByRole("heading", { name: "Deferred workers page" })).toBeTruthy();
  expect(loadWorkers).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Ada · admin" })).toBeTruthy();
});
