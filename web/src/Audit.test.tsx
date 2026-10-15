import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { Audit, auditSearch } from "./Audit";

function render(ui: Parameters<typeof renderBase>[0]) {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  return renderBase(<Theme>{ui}</Theme>);
}

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
  expect(await screen.findByText("login")).toBeTruthy();
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

test("keeps filters collapsed by default and preserves active values when closed", async () => {
  stubAdminAudit();
  renderAudit();
  await screen.findByText("login");
  const summary = screen.getByText("Filters", { exact: true });
  const disclosure = summary.closest("details");
  if (!disclosure) throw new Error("Filters summary must belong to a native disclosure");
  expect(disclosure.open).toBe(false);
  expect(disclosure.contains(screen.getByRole("button", { name: "Export audit" }))).toBe(false);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(true);
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "bucket-1" } });
  expect(summary.textContent).toBe("Filters (1)");
  fireEvent.click(summary);
  expect(disclosure.open).toBe(false);
  fireEvent.click(summary);
  expect((screen.getByLabelText("Target") as HTMLInputElement).value).toBe("bucket-1");
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "" } });
  expect(summary.textContent).toBe("Filters");
});

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
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2023-11-14T22:13:20" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2023-11-14T22:15:00" } });
  const target = screen.getByLabelText("Target");
  expect(target.getAttribute("aria-describedby")).toBe("audit-target-hint");
  expect(screen.getByText("Exact target match, such as a bucket or key ID.").id).toBe("audit-target-hint");
  fireEvent.change(target, { target: { value: "bucket-1" } });
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

test("preflights audit export and streams the filtered CSV through a native download", async () => {
  const response = new Response(null, { status: 200, headers: { "content-type": "text/csv" } });
  const blob = vi.spyOn(response, "blob");
  const downloads: { href: string | null; name: string; connected: boolean }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.getAttribute("href"), name: this.download, connected: this.isConnected });
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/audit/export")) return response;
    return json({ items: [auditRow], hasMore: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderAudit();
  await screen.findByText("login");
  fireEvent.change(screen.getByLabelText("User"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "bucket-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledWith("/api/audit/export?user=Ada&action=bucket-1", {
    method: "HEAD", credentials: "include",
  });
  expect(downloads).toEqual([{ href: "/api/audit/export?user=Ada&action=bucket-1", name: "audit.csv", connected: true }]);
  expect(blob).not.toHaveBeenCalled();
  expect(document.querySelector('a[download="audit.csv"]')).toBeNull();
});

test("shows an export failure without starting a native download when the preflight is rejected", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/audit/export")) return new Response(null, { status: 403 });
    return json({ items: [auditRow], hasMore: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderAudit();
  await screen.findByText("login");
  fireEvent.click(screen.getByRole("button", { name: "Export audit" }));
  expect(await screen.findByText("Export failed")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/audit/export", { method: "HEAD", credentials: "include" });
  expect(click).not.toHaveBeenCalled();
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
  expect(screen.getByLabelText("Loading audit").getAttribute("role")).toBe("status");
  expect(screen.getByText("Loading audit")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no audit events.")).toBeNull();
  expect(screen.queryByText("Refreshing audit")).toBeNull();
  expect(screen.getByLabelText("User")).toBeTruthy();
  expect(screen.getByLabelText("From")).toBeTruthy();
  expect(screen.getByLabelText("To")).toBeTruthy();
  expect(screen.getByLabelText("Target")).toBeTruthy();
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
  expect(screen.getByLabelText("Target")).toBeTruthy();
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
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "login" } });
  await screen.findByText("page-0");
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)?.searchParams.get("user")).toBe("Ada");
  expect(requests.at(-1)?.searchParams.get("action")).toBe("login");
});


test("encodes audit UTC filters as Unix seconds and preserves unset fields", () => {
  expect(auditSearch({ user: "Ada", from: "2023-11-14T22:13:20", to: "2023-11-14T22:15", action: "login" })).toBe("?user=Ada&from=1700000000&to=1700000100&action=login");
  expect(auditSearch({ user: "", from: "", to: "", action: "" })).toBe("");
});

test("rejects malformed and impossible UTC audit dates", () => {
  expect(typeof auditSearch).toBe("function");
  for (const from of ["1700000000", "2023-02-29T12:00", "invalid"]) {
    expect(() => auditSearch({ user: "", from, to: "", action: "" })).toThrow();
  }
});

test("changing a UTC date resets audit pagination with seconds in the request", async () => {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ui.local");
    requests.push(url);
    return json({ items: [{ ...auditRow, reason: `date-page-${url.searchParams.get("offset")}` }], hasMore: true });
  }));
  renderAudit();
  await screen.findByText("date-page-0");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("date-page-100");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2023-11-14T22:13:20" } });
  await screen.findByText("date-page-0");
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  expect(requests.at(-1)?.searchParams.get("from")).toBe("1700000000");
});


test("an invalid native UTC date blocks list and export requests visibly", async () => {
  const fetchMock = stubAdminAudit();
  renderAudit();
  await screen.findByText("login");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2023-11-14T22:13:20" } });
  await waitFor(() => expect(auditUrls(fetchMock, "list").at(-1)).toContain("from=1700000000"));
  const input = screen.getByLabelText("From") as HTMLInputElement;
  Object.defineProperty(input, "validity", { configurable: true, value: { badInput: true, valid: false } });
  const count = fetchMock.mock.calls.length;
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("alert").textContent).toBe("Enter a valid UTC date and time.");
  expect((screen.getByRole("button", { name: "Export audit" }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.length).toBe(count);
});


test("renders known audit epoch seconds as a readable UTC instant and preserves invalid raw values", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [auditRow, { ...auditRow, at: "not-a-timestamp", reason: "invalid-time" }], hasMore: false })));
  renderAudit();
  await screen.findByText("login");
  const time = document.querySelector("time");
  expect(time?.getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
  expect(time?.textContent).toContain("UTC");
  expect(screen.getByText("not-a-timestamp")).toBeTruthy();
});
