import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
