import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { Audit } from "./Audit";

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
      <App />
    </QueryClientProvider>,
  );
}

function stubAdminAudit() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
    if (url.includes("/api/audit/export")) {
      return new Response("at,username,ip,result,reason,method,path,target,status\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    if (url.includes("/api/audit")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              at: 1700000000,
              username: "Ada",
              ip: "127.0.0.1",
              result: "success",
              reason: "login",
              method: "POST",
              path: "/api/auth/login",
              target: "",
              status: 200,
            },
          ],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("an admin on #audit sees Ada and login", async () => {
  window.location.hash = "#audit";
  const fetchMock = stubAdminAudit();
  renderApp();
  expect(await screen.findByText("Ada")).toBeTruthy();
  expect(screen.getByText("login")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Audit" }).getAttribute("href")).toBe("#audit");
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  await waitFor(() => {
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/audit/export")).toBe(true);
  });
});

function auditUrls(fetchMock: ReturnType<typeof stubAdminAudit>, kind: "list" | "export"): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) =>
      kind === "export"
        ? url === "/api/audit/export" || url.startsWith("/api/audit/export?")
        : url === "/api/audit" || url.startsWith("/api/audit?"),
    );
}

test("filtering the audit list by user Ada", async () => {
  window.location.hash = "#audit";
  const fetchMock = stubAdminAudit();
  renderApp();
  expect(await screen.findByText("login")).toBeTruthy();
  expect(auditUrls(fetchMock, "list")).toEqual(["/api/audit?offset=0&limit=100"]);
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  await waitFor(() => {
    expect(auditUrls(fetchMock, "export")).toEqual(["/api/audit/export"]);
  });
  fireEvent.change(screen.getByLabelText("User"), { target: { value: "Ada" } });
  await waitFor(() => {
    expect(auditUrls(fetchMock, "list").at(-1)).toBe("/api/audit?user=Ada&offset=0&limit=100");
  });
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "1700000000" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "1700000100" } });
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "bucket-1" } });
  await waitFor(() => {
    expect(auditUrls(fetchMock, "list").at(-1)).toBe(
      "/api/audit?user=Ada&from=1700000000&to=1700000100&action=bucket-1&offset=0&limit=100",
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  await waitFor(() => {
    expect(auditUrls(fetchMock, "export").at(-1)).toBe(
      "/api/audit/export?user=Ada&from=1700000000&to=1700000100&action=bucket-1",
    );
  });
});

test("exporting audit downloads audit.csv", async () => {
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:audit-csv";
  URL.revokeObjectURL = () => undefined;
  window.location.hash = "#audit";
  const fetchMock = stubAdminAudit();
  renderApp();
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Export audit" }));
    await waitFor(() => {
      const link = document.querySelector('a[download="audit.csv"]');
      expect(link?.getAttribute("download")).toBe("audit.csv");
    });
    const exportUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/api/audit/export"));
    expect(exportUrl).toBe("/api/audit/export");
  } finally {
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const auditRow = {
  at: 1700000000,
  username: "Ada",
  ip: "127.0.0.1",
  result: "success",
  reason: "login",
  method: "POST",
  path: "/api/auth/login",
  target: "",
  status: 200,
};

function renderAudit() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Audit />
    </QueryClientProvider>,
  );
  return client;
}

test("shows Loading audit and marks the audit section busy on the first load", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  renderAudit();
  const section = screen.getByRole("region", { name: "Audit" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading audit").getAttribute("role")).toBeNull();
  expect(screen.queryByText("Loading audit")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no audit events.")).toBeNull();
  expect(screen.queryByText("Refreshing audit")).toBeNull();
  expect(screen.getByLabelText("User")).toBeTruthy();
  expect(screen.getByLabelText("From")).toBeTruthy();
  expect(screen.getByLabelText("To")).toBeTruthy();
  expect(screen.getByLabelText("Action")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export audit" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
  release(json({ items: [auditRow], hasMore: false }));
  expect(await screen.findByText("login")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Audit" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByLabelText("Loading audit")).toBeNull();
  expect(screen.queryByText("Loading audit")).toBeNull();
});

test("says there are no audit events", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/audit");
      expect(init?.credentials).toBe("include");
      return json({ items: [], hasMore: false });
    }),
  );
  renderAudit();
  expect((await screen.findByText("There are no audit events.")).textContent).toBe(
    "There are no audit events.",
  );
  expect(screen.getByText("There are no audit events.").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
  expect(screen.getByRole("button", { name: "Export audit" })).toBeTruthy();
  expect(screen.getByLabelText("User")).toBeTruthy();
  expect(screen.getByLabelText("From")).toBeTruthy();
  expect(screen.getByLabelText("To")).toBeTruthy();
  expect(screen.getByLabelText("Action")).toBeTruthy();
  expect(screen.queryByText("login")).toBeNull();
  expect(screen.queryByLabelText("Loading audit")).toBeNull();
  expect(screen.queryByText("Loading audit")).toBeNull();
  expect(screen.getByRole("region", { name: "Audit" }).getAttribute("aria-busy")).toBe("false");
});

test("shows the API code and requests the audit list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/audit");
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json({ code: "upstream_failed", message: "Garage returned an error" }, 502);
      }
      return json({ items: [auditRow], hasMore: false });
    }),
  );
  renderAudit();
  expect((await screen.findByText("Garage returned an error")).textContent).toBe(
    "Garage returned an error",
  );
  expect(screen.getByText("upstream_failed").textContent).toBe("upstream_failed");
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no audit events.")).toBeNull();
  expect(screen.getByLabelText("User")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export audit" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("login")).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps one visible audit row while a later fetch refreshes", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/audit");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json({ items: [auditRow], hasMore: false }));
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderAudit();
  expect(await screen.findByText("login")).toBeTruthy();
  expect(screen.queryByText("Refreshing audit")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["audit"] });
  expect(await screen.findByText("Refreshing audit")).toBeTruthy();
  expect(screen.getByText("login")).toBeTruthy();
  expect(screen.getByText("Ada")).toBeTruthy();
  expect(screen.queryByLabelText("Loading audit")).toBeNull();
  expect(screen.queryByText("Loading audit")).toBeNull();
  expect(screen.getByRole("region", { name: "Audit" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByRole("alert")).toBeNull();
  releaseNext(json({ items: [auditRow], hasMore: false }));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing audit")).toBeNull();
  });
  expect(screen.getByText("login")).toBeTruthy();
  expect(calls).toBe(2);
});

test("pages audit with filters and resets the range when filters change", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    requests.push(url);
    return json({ items: [{ ...auditRow, reason: `page-${url.searchParams.get("offset") ?? "0"}` }], hasMore: true });
  }));
  renderAudit();
  await screen.findByText("page-0");
  expect(requests.at(-1)?.searchParams.get("limit")).toBe("100");
  fireEvent.change(screen.getByLabelText("User"), { target: { value: "Ada" } });
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("user")).toBe("Ada"));
  await waitFor(() => expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("page-100");
  expect(requests.at(-1)?.searchParams.get("user")).toBe("Ada");
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByText("page-0");
  await waitFor(() => expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("page-100");
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "login" } });
  await screen.findByText("page-0");
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)?.searchParams.get("user")).toBe("Ada");
  expect(requests.at(-1)?.searchParams.get("action")).toBe("login");
});
