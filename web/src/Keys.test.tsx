import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Keys } from "./Keys";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

function renderKeys(canManage = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Keys canManage={canManage} />
    </QueryClientProvider>,
  );
  return client;
}

type Call = {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  csrf: string | null;
  confirm: string | null;
  body: unknown;
};

function recordedCall(input: RequestInfo | URL, init?: RequestInit): Call {
  const headers = new Headers(init?.headers);
  const raw = init?.body;
  return {
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    credentials: init?.credentials,
    csrf: headers.get("x-csrf-token"),
    confirm: headers.get("x-confirm"),
    body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
  };
}

function pageHolds(secret: string): boolean {
  if (document.body.textContent?.includes(secret)) {
    return true;
  }
  for (const node of document.body.querySelectorAll("*")) {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      if (node.value.includes(secret)) {
        return true;
      }
    }
    for (const name of node.getAttributeNames()) {
      if (node.getAttribute(name)?.includes(secret)) {
        return true;
      }
    }
  }
  return false;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("shows the key id and a string name without showing a secret or a non-string name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(init?.credentials).toBe("include");
      expect(init?.method ?? "GET").toBe("GET");
      return json({
        items: [
          { id: "key-1", name: "a&b=c", secretAccessKey: "SECRETVALUE" },
          { id: "key-2", name: { display: "hidden-name" } },
          { id: "key-3", name: 9157 },
          { id: "key-4" },
        ],
        hasMore: false,
      });
    }),
  );
  renderKeys();
  expect(await screen.findByText("key-1")).toBeTruthy();
  expect(screen.getByText("key-2")).toBeTruthy();
  expect(screen.getByText("key-3")).toBeTruthy();
  expect(screen.getByText("key-4")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(screen.queryByText("hidden-name")).toBeNull();
  expect(screen.queryByText("9157")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByText("More keys are available.")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("loads the next page at the offset after the rows already shown", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      const offset = url.searchParams.get("offset");
      if (offset === "0") {
        return json({
          items: [
            { id: "first", name: "a&b=c" },
            { id: "middle", name: 9157 },
          ],
          hasMore: true,
        });
      }
      if (offset === "2") {
        return json({
          items: [{ id: "second", name: "kept" }],
          hasMore: false,
        });
      }
      return json({ message: "unexpected offset" }, 500);
    }),
  );
  renderKeys();
  expect(await screen.findByText("first")).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  expect(screen.queryByText("9157")).toBeNull();
  expect(screen.getByText("More keys are available.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(calls).toEqual([
    "/api/keys?offset=0&limit=100",
    "/api/keys?offset=2&limit=100",
  ]);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByText("More keys are available.")).toBeNull();
});

test("shows Loading keys and marks the keys section busy on the first load", async () => {
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
  renderKeys();
  const section = screen.getByRole("region", { name: "Keys" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading keys").getAttribute("role")).toBeNull();
  expect(screen.queryByText("Loading keys")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no keys.")).toBeNull();
  expect(screen.queryByText("Refreshing keys")).toBeNull();
  release(json({ items: [], hasMore: false }));
  expect(await screen.findByText("There are no keys.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  expect(screen.getByRole("region", { name: "Keys" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByLabelText("Loading keys")).toBeNull();
  expect(screen.queryByText("Loading keys")).toBeNull();
});

test("keeps a visible key id while a later fetch refreshes the list", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json({ items: [{ id: "GK9", name: "kept" }], hasMore: false }));
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderKeys();
  expect(await screen.findByText("GK9")).toBeTruthy();
  expect(screen.queryByText("Refreshing keys")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["keys"] });
  expect(await screen.findByText("Refreshing keys")).toBeTruthy();
  expect(screen.getByText("GK9")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(screen.queryByLabelText("Loading keys")).toBeNull();
  expect(screen.queryByText("Loading keys")).toBeNull();
  expect(screen.getByRole("region", { name: "Keys" }).getAttribute("aria-busy")).toBe("false");
  releaseNext(json({ items: [{ id: "GK9", name: "kept" }], hasMore: false }));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing keys")).toBeNull();
  });
  expect(screen.getByText("GK9")).toBeTruthy();
  expect(calls).toBe(2);
});

test("shows the error message when the key list request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderKeys();
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows the API code and requests the key list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/keys");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json(
          { code: "upstream_failed", message: "Garage returned an error" },
          502,
        );
      }
      return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
    }),
  );
  renderKeys();
  expect(await screen.findByText("Garage returned an error")).toBeTruthy();
  expect(screen.getByText("upstream_failed")).toBeTruthy();
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no keys.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("keeps the loaded rows when the next page fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const offset = new URL(String(input), "http://ui.local").searchParams.get("offset");
      if (offset === "0") {
        return json({ items: [{ id: "first", name: "kept" }], hasMore: true });
      }
      return json({ message: "page failed" }, 502);
    }),
  );
  renderKeys();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("page failed")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
});

test("does not render a page that contains a key without an id", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          { id: "key-ok", name: "visible", secretAccessKey: "SECRETVALUE" },
          { id: "", name: "skip-me", secretAccessKey: "OTHERSECRET" },
        ],
        hasMore: true,
      }),
    ),
  );
  renderKeys();
  expect(await screen.findByText("Keys are unavailable")).toBeTruthy();
  expect(screen.queryByText("key-ok")).toBeNull();
  expect(screen.queryByText("visible")).toBeNull();
  expect(screen.queryByText("skip-me")).toBeNull();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(screen.queryByText("OTHERSECRET")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("a viewer sees the key list and does not call key write routes", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(recordedCall(input, init));
      return json({
        items: [{ id: "GK1", name: "photos", secretAccessKey: "SECRETVALUE" }],
        hasMore: false,
      });
    }),
  );
  renderKeys(false);
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename GK1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete GK1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "View secret for GK1" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Allow create bucket for GK1" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.every((call) => call.method === "GET" && call.url.startsWith("/api/keys?"))).toBe(
    true,
  );
});

test("keeps the typed name and shows the API message when create fails", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST") {
        return json({ message: "Key name is invalid" }, 400);
      }
      return json({ items: [], hasMore: false });
    }),
  );
  renderKeys(true);
  const createPanel = screen.queryByRole("button", { name: "Create" });
  if (createPanel) fireEvent.click(createPanel);
  expect(await screen.findByText("There are no keys. Create the first key.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "my key" } });
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  expect(await screen.findByText("Key name is invalid")).toBeTruthy();
  expect((screen.getByLabelText("Key name") as HTMLInputElement).value).toBe("my key");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Key created")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.find((call) => call.method === "POST")).toEqual({
    url: "/api/keys",
    method: "POST",
    credentials: "include",
    csrf: "csrf-token",
    confirm: null,
    body: { name: "my key" },
  });
});

test("shows a created secret once, copies it, and removes it when the dialog closes", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const openDb = vi.fn();
  vi.stubGlobal("indexedDB", { open: openDb });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const calls: Call[] = [];
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST" && call.url === "/api/keys") {
        created = true;
        return json({
          accessKeyId: "GK1",
          name: "photo_roll-1",
          secretAccessKey: "ONCESECRET",
          permissions: { createBucket: false },
        });
      }
      return json({
        items: created
          ? [{ id: "GK1", name: "photo_roll-1", secretAccessKey: "LISTSECRET" }]
          : [],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  const createPanel = screen.queryByRole("button", { name: "Create" });
  if (createPanel) fireEvent.click(createPanel);
  fireEvent.change(await screen.findByLabelText("Key name"), {
    target: { value: "photo_roll-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  expect(await screen.findByRole("heading", { name: "Secret for GK1" })).toBeTruthy();
  expect(await screen.findByText("GK1")).toBeTruthy();
  expect(screen.getByText("Key created")).toBeTruthy();
  expect((screen.getByLabelText("Key name") as HTMLInputElement).value).toBe("");
  const field = screen.getByLabelText("Secret access key") as HTMLInputElement;
  expect(field.type).toBe("password");
  expect(field.value).toBe("ONCESECRET");
  expect(document.body.textContent).not.toContain("ONCESECRET");
  expect(document.body.textContent).not.toContain("LISTSECRET");
  fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
  expect(field.type).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
  expect(await screen.findByText("Copied")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith("ONCESECRET");
  fireEvent.click(screen.getByRole("button", { name: "I have saved it" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pageHolds("ONCESECRET")).toBe(false);
  expect(pageHolds("LISTSECRET")).toBe(false);
  expect(screen.getByText("GK1")).toBeTruthy();
  expect(setItem).not.toHaveBeenCalled();
  expect(openDb).not.toHaveBeenCalled();
  expect(calls.find((call) => call.method === "POST")).toEqual({
    url: "/api/keys",
    method: "POST",
    credentials: "include",
    csrf: "csrf-token",
    confirm: null,
    body: { name: "photo_roll-1" },
  });
});

test("asks the operator to select the secret when the page is not a secure context", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "POST") {
        return json({ accessKeyId: "GK1", secretAccessKey: "ONCESECRET" });
      }
      return json({ items: [], hasMore: false });
    }),
  );
  renderKeys(true);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  fireEvent.change(await screen.findByLabelText("Key name"), { target: { value: "photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  const field = (await screen.findByLabelText("Secret access key")) as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
  expect(await screen.findByText("Select the secret and copy it")).toBeTruthy();
  expect(field.type).toBe("text");
  expect(field.value).toBe("ONCESECRET");
  expect(writeText).not.toHaveBeenCalled();
});

test("renames a key with only the name and does not ask for confirmation", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "PATCH") {
        return json({ accessKeyId: "GK1", name: "已有 名称", secretAccessKey: "PATCHSECRET" });
      }
      return json({
        items: [{ id: "GK1", name: "photos", secretAccessKey: "LISTSECRET" }],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  await waitFor(() => expect(document.querySelector("tbody details")).toBeTruthy());
  for (const details of document.querySelectorAll<HTMLDetailsElement>("tbody details")) {
    if (!details.open) {
      const summary = details.querySelector("summary");
      if (!summary) throw new Error("Editor disclosure has no summary");
      fireEvent.click(summary);
    }
  }
  const name = (await screen.findByLabelText("Name for GK1")) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "已有 名称" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.change(name, { target: { value: "photos" } });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(name, { target: { value: "已有 名称" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rename GK1" }));
  expect(await screen.findByText("Key renamed")).toBeTruthy();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pageHolds("PATCHSECRET")).toBe(false);
  expect(pageHolds("LISTSECRET")).toBe(false);
  expect((screen.getByLabelText("Name for GK1") as HTMLInputElement).value).toBe("已有 名称");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.find((call) => call.method === "PATCH")).toEqual({
    url: "/api/keys/GK1",
    method: "PATCH",
    credentials: "include",
    csrf: "csrf-token",
    confirm: null,
    body: { name: "已有 名称" },
  });
});

test("sends only createBucket when the allow-create-bucket switch changes", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "PATCH") {
        return json({ accessKeyId: "GK1", secretAccessKey: "PATCHSECRET" });
      }
      return json({
        items: [
          { id: "GK1", name: "photos", permissions: { createBucket: false } },
          { id: "GK2", name: "unknown" },
        ],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  await waitFor(() => expect(document.querySelector("tbody details")).toBeTruthy());
  for (const details of document.querySelectorAll<HTMLDetailsElement>("tbody details")) {
    if (!details.open) {
      const summary = details.querySelector("summary");
      if (!summary) throw new Error("Editor disclosure has no summary");
      fireEvent.click(summary);
    }
  }
  const known = (await screen.findByRole("checkbox", {
    name: "Allow create bucket for GK1",
  })) as HTMLInputElement;
  const unknown = screen.getByRole("checkbox", {
    name: "Allow create bucket for GK2",
  }) as HTMLInputElement;
  expect(known.checked).toBe(false);
  expect(known.indeterminate).toBe(false);
  expect(unknown.checked).toBe(false);
  expect(unknown.indeterminate).toBe(true);
  fireEvent.click(known);
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });
  expect(known.checked).toBe(true);
  fireEvent.click(known);
  await waitFor(() => {
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
  });
  expect(known.checked).toBe(false);
  expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
    { createBucket: true },
    { createBucket: false },
  ]);
  expect(pageHolds("PATCHSECRET")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows the API message when the create-bucket switch fails and keeps the previous value", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "PATCH") {
        return json({ message: "Garage admin API is not configured" }, 502);
      }
      return json({
        items: [{ id: "GK1", name: "photos", permissions: { createBucket: true } }],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  await waitFor(() => expect(document.querySelector("tbody details")).toBeTruthy());
  for (const details of document.querySelectorAll<HTMLDetailsElement>("tbody details")) {
    if (!details.open) {
      const summary = details.querySelector("summary");
      if (!summary) throw new Error("Editor disclosure has no summary");
      fireEvent.click(summary);
    }
  }
  const box = (await screen.findByRole("checkbox", {
    name: "Allow create bucket for GK1",
  })) as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(box.checked).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows Saving while allow-create-bucket is pending and keeps the error when it fails", async () => {
  let release: (response: Response) => void = () => {};
  const calls: Call[] = [];
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json({
        items: [{ id: "GK1", name: "photos", permissions: { createBucket: false } }],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  await waitFor(() => expect(document.querySelector("tbody details")).toBeTruthy());
  for (const details of document.querySelectorAll<HTMLDetailsElement>("tbody details")) {
    if (!details.open) {
      const summary = details.querySelector("summary");
      if (!summary) throw new Error("Editor disclosure has no summary");
      fireEvent.click(summary);
    }
  }
  const box = (await screen.findByRole("checkbox", {
    name: "Allow create bucket for GK1",
  })) as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(box.disabled).toBe(false);
  expect(screen.queryByText("Saving")).toBeNull();
  fireEvent.click(box);
  expect(await screen.findByText("Saving")).toBeTruthy();
  expect(box.disabled).toBe(true);
  expect(box.checked).toBe(false);
  expect(calls.filter((call) => call.method === "PATCH")).toEqual([
    {
      url: "/api/keys/GK1",
      method: "PATCH",
      credentials: "include",
      csrf: "csrf-token",
      confirm: null,
      body: { createBucket: true },
    },
  ]);
  release(json({ message: "Garage admin API is not configured" }, 502));
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.queryByText("Saving")).toBeNull();
  expect(box.disabled).toBe(false);
  expect(box.checked).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("cancels a key delete without a request, then confirms the encoded delete", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const calls: Call[] = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return json({
        items: deleted ? [] : [{ id: "a b&c=d", name: "photos" }],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  fireEvent.click(await screen.findByRole("button", { name: "Delete a b&c=d" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("a b&c=d");
  expect(dialog.textContent).toContain("lose access");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete a b&c=d" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete a b&c=d" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText("Key deleted")).toBeTruthy();
  expect(await screen.findByText("There are no keys. Create the first key.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  expect(screen.queryByText("a b&c=d")).toBeNull();
  expect(calls.find((call) => call.method === "DELETE")).toEqual({
    url: "/api/keys/a%20b%26c%3Dd",
    method: "DELETE",
    credentials: "include",
    csrf: "csrf-token",
    confirm: null,
    body: undefined,
  });
});

test("shows Working while a key delete is submitting and Cancel still closes", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
    }),
  );
  renderKeys(true);
  const opener = (await screen.findByRole("button", { name: "Delete GK1" })) as HTMLButtonElement;
  expect(opener.disabled).toBe(false);
  expect(opener.textContent).toBe("Delete");
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  expect(confirm.textContent).toBe("Confirm");
  fireEvent.click(confirm);
  const working = (await within(dialog).findByRole("button", { name: "Working" })) as HTMLButtonElement;
  expect(working.disabled).toBe(true);
  expect(working.textContent).toBe("Working");
  expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
  const during = screen.getByRole("button", { name: "Delete GK1" }) as HTMLButtonElement;
  expect(during.disabled).toBe(false);
  expect(during.textContent).toBe("Delete");
  expect(screen.getByText("photos")).toBeTruthy();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("GK1")).toBeTruthy();
  expect(screen.getByText("photos")).toBeTruthy();
  expect(screen.queryByText("Key deleted")).toBeNull();
  const after = screen.getByRole("button", { name: "Delete GK1" }) as HTMLButtonElement;
  expect(after.disabled).toBe(false);
  expect(after.textContent).toBe("Delete");
  await act(async () => {
    release(json({ message: "Key is still in use" }, 409));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Key deleted")).toBeNull();
  expect(screen.getByText("GK1")).toBeTruthy();
});

test("shows the API message when deleting a key fails and keeps the key listed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "DELETE") {
        return json({ message: "Key is still in use" }, 409);
      }
      return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
    }),
  );
  renderKeys(true);
  fireEvent.click(await screen.findByRole("button", { name: "Delete GK1" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText(/Key is still in use/)).toBeTruthy();
  const failed = screen.getByRole("dialog");
  expect(failed.textContent).toContain(
    "This permanently deletes key GK1. Clients that use this key lose access.",
  );
  expect(failed.textContent).toContain("Key is still in use");
  expect(screen.getByText("GK1")).toBeTruthy();
  expect(screen.queryByText("Key deleted")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("views a secret with confirmation and removes it when the dialog closes", async () => {
  document.cookie = "garage_csrf=csrf-token";
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      calls.push(call);
      if (call.method === "POST") {
        return json({
          accessKeyId: "a b&c=d",
          secretAccessKey: "VIEWSECRET",
          name: "NOTINLIST",
        });
      }
      return json({
        items: [{ id: "a b&c=d", name: "photos", secretAccessKey: "LISTSECRET" }],
        hasMore: false,
      });
    }),
  );
  renderKeys(true);
  expect(await screen.findByText("photos")).toBeTruthy();
  expect(pageHolds("LISTSECRET")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "View secret for a b&c=d" }));
  const field = (await screen.findByLabelText("Secret access key")) as HTMLInputElement;
  expect(field.value).toBe("VIEWSECRET");
  expect(screen.queryByText("NOTINLIST")).toBeNull();
  expect(pageHolds("LISTSECRET")).toBe(false);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pageHolds("VIEWSECRET")).toBe(false);
  expect(setItem).not.toHaveBeenCalled();
  expect(calls.find((call) => call.method === "POST")).toEqual({
    url: "/api/keys/a%20b%26c%3Dd/secret",
    method: "POST",
    credentials: "include",
    csrf: "csrf-token",
    confirm: "yes",
    body: undefined,
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows the API message when a secret view fails and does not open the dialog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordedCall(input, init);
      if (call.method === "POST") {
        return json({ message: "Confirmation required" }, 403);
      }
      return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
    }),
  );
  renderKeys(true);
  fireEvent.click(await screen.findByRole("button", { name: "View secret for GK1" }));
  expect(await screen.findByText("Confirmation required")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("summarizes a long key identifier while keeping the complete address inspectable", async () => {
  const resourceId = "b".repeat(64);
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ id: resourceId, name: "Long key" }], hasMore: false })));
  renderKeys(true);
  const link = await screen.findByRole("link", { name: resourceId });
  expect(link.textContent).toBe(`${resourceId.slice(0, 12)}…${resourceId.slice(-8)}`);
  expect(link.getAttribute("title")).toBe(resourceId);
  expect(link.getAttribute("href")).toBe(`#key/${resourceId}/overview`);
  fireEvent.click(screen.getByLabelText(`Edit ${resourceId}`));
  expect(screen.getByText(resourceId, { selector: "p" })).toBeTruthy();
});

function keyRowText(): string[] {
  return screen.getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
}

test("filters loaded keys from the query string and keeps that choice in the address", async () => {
  window.history.replaceState(null, "", "/?keys=APPLE&keep=1#keys/stay");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return json({
        items: [
          { id: "k-b", name: "mango" },
          { id: "k-a", name: "apple" },
          { id: "k-c", name: null },
        ],
        hasMore: true,
      });
    }),
  );
  renderKeys();
  expect(await screen.findByText("k-a")).toBeTruthy();
  expect(screen.getByText("apple")).toBeTruthy();
  expect(screen.queryByText("k-b")).toBeNull();
  expect(screen.queryByText("k-c")).toBeNull();
  expect((screen.getByLabelText("Filter keys") as HTMLInputElement).value).toBe("APPLE");
  expect(screen.getByText("Default order is Id.").textContent).toBe("Default order is Id.");
  expect(screen.getByText("Only loaded rows").textContent).toBe("Only loaded rows");
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect(screen.queryByText("There are no keys.")).toBeNull();
  expect(window.location.hash).toBe("#keys/stay");
  expect(window.location.search).toContain("keys=APPLE");
  expect(window.location.search).toContain("keep=1");
  expect(calls).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter keys"), { target: { value: "" } });
  expect(screen.getByText("k-b")).toBeTruthy();
  expect(screen.getByText("k-a")).toBeTruthy();
  expect(screen.getByText("k-c")).toBeTruthy();
  expect(keyRowText()[0]).toContain("k-b");
  expect(window.location.search).toBe("?keep=1");
  expect(window.location.hash).toBe("#keys/stay");
  expect(calls).toBe(1);

  fireEvent.change(screen.getByLabelText("Sort keys"), { target: { value: "name" } });
  expect(keyRowText()[0]).toContain("k-c");
  expect(keyRowText()[1]).toContain("k-a");
  expect(keyRowText()[2]).toContain("k-b");
  expect(window.location.search).toContain("keysSort=name");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#keys/stay");
  expect(calls).toBe(1);

  fireEvent.change(screen.getByLabelText("Filter keys"), { target: { value: "K-C" } });
  expect(screen.getByText("k-c")).toBeTruthy();
  expect(screen.queryByText("k-a")).toBeNull();
  expect(screen.queryByText("k-b")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect(window.location.search).toContain("keys=K-C");
  expect(window.location.search).toContain("keysSort=name");
  expect(window.location.hash).toBe("#keys/stay");
  expect(calls).toBe(1);

  act(() => {
    window.history.pushState(null, "", "/?keys=missing&keep=1#keys/stay");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByText("k-a")).toBeNull();
  expect(screen.queryByText("k-b")).toBeNull();
  expect(screen.queryByText("k-c")).toBeNull();
  expect(screen.queryByText("There are no keys.")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  expect((screen.getByLabelText("Filter keys") as HTMLInputElement).value).toBe("missing");
  expect((screen.getByLabelText("Sort keys") as HTMLSelectElement).value).toBe("id");
  expect(window.location.hash).toBe("#keys/stay");
  expect(calls).toBe(1);
});

test("sorts loaded keys by created time and keeps the choice in the address", async () => {
  window.history.replaceState(null, "", "/?keep=1#keys/stay");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      return json({
        items: [
          { id: "later-key", name: "later", created: "2026-10-12T00:00:00Z" },
          { id: "earlier-key", name: "earlier", created: "2026-01-02T00:00:00Z" },
          { id: "undated-key", name: "undated" },
        ],
        hasMore: false,
      });
    }),
  );
  renderKeys();
  expect(await screen.findByText("later-key")).toBeTruthy();
  expect(keyRowText()[0]).toContain("later-key");
  expect(keyRowText()[1]).toContain("earlier-key");
  expect(keyRowText()[2]).toContain("undated-key");
  const created = screen.getByRole("option", { name: "Created" }) as HTMLOptionElement;
  expect(created.value).toBe("created");

  fireEvent.change(screen.getByLabelText("Sort keys"), { target: { value: "created" } });
  expect(keyRowText()[0]).toContain("earlier-key");
  expect(keyRowText()[1]).toContain("later-key");
  expect(keyRowText()[2]).toContain("undated-key");
  expect(window.location.search).toContain("keysSort=created");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#keys/stay");
  expect((screen.getByLabelText("Sort keys") as HTMLSelectElement).value).toBe("created");
  expect(calls).toBe(1);
});

test("lists the buckets a key can access with read, write, and owner", async () => {
  window.location.hash = "#key/GK1/buckets";
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://ui.local");
      calls.push(url.pathname);
      if (url.pathname === "/api/keys") {
        return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
      }
      if (url.pathname === "/api/keys/GK1") {
        return json({
          accessKeyId: "GK1",
          name: "photos",
          secretAccessKey: "SECRETVALUE",
          buckets: [
            {
              id: "bkt-photos",
              globalAliases: ["photos"],
              localAliases: ["roll"],
              permissions: { owner: true, read: true, write: false },
            },
            {
              id: "bkt-logs",
              globalAliases: [],
              localAliases: [],
              permissions: { owner: false, read: false, write: true },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }),
  );
  renderKeys();
  const photos = await screen.findByRole("row", { name: "bkt-photos" });
  const logs = screen.getByRole("row", { name: "bkt-logs" });
  expect(within(photos).getByText("bkt-photos")).toBeTruthy();
  expect(within(photos).getByText("photos")).toBeTruthy();
  expect(within(photos).getByText("roll")).toBeTruthy();
  expect(within(photos).getByText("read yes")).toBeTruthy();
  expect(within(photos).getByText("write no")).toBeTruthy();
  expect(within(photos).getByText("owner yes")).toBeTruthy();
  expect(within(logs).getByText("bkt-logs")).toBeTruthy();
  expect(within(logs).getByText("read no")).toBeTruthy();
  expect(within(logs).getByText("write yes")).toBeTruthy();
  expect(within(logs).getByText("owner no")).toBeTruthy();
  expect(screen.queryByText("Buckets this key can access")).toBeNull();
  expect(screen.queryByText("SECRETVALUE")).toBeNull();
  expect(window.location.hash).toBe("#key/GK1/buckets");
  expect(calls).toContain("/api/keys/GK1");
});

test("the key buckets tab shows the grant bits", async () => {
  window.location.hash = "#key/GK1/buckets";
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url, "http://ui.local");
      if (parsed.pathname === "/api/keys") {
        return json({ items: [{ id: "GK1", name: "photos" }], hasMore: false });
      }
      if (url === "/api/keys/GK1") {
        return json({
          buckets: [
            {
              id: "bkt-photos",
              permissions: { owner: true, read: true, write: false },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  renderKeys();
  const bucket = await screen.findByRole("row", { name: "bkt-photos" });
  expect(within(bucket).getByText("owner yes").textContent).toBe("owner yes");
  expect(within(bucket).getByText("read yes").textContent).toBe("read yes");
  expect(within(bucket).getByText("write no").textContent).toBe("write no");
  expect(screen.getByRole("tab", { name: "Overview" }).textContent).toBe("Overview");
  expect(screen.getByRole("tab", { name: "Buckets" }).textContent).toBe("Buckets");
  expect(screen.getByRole("tab", { name: "Settings" }).textContent).toBe("Settings");
  expect(calls).toContain("/api/keys/GK1");
});

 test("creation and row editing open on demand and keep collapsed drafts", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [{ id: "compact", name: "Existing", createBucket: false }], hasMore: false })));
  renderKeys(true);
  expect(await screen.findByText("compact")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Key name" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("textbox", { name: "Key name" })).toBeTruthy();
  const disclosure = screen.getByLabelText("Edit compact").closest("details");
  expect(disclosure?.open).toBe(false);
  fireEvent.click(screen.getByLabelText("Edit compact"));
  const input = screen.getByLabelText("Name for compact") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "42" } });
  fireEvent.click(screen.getByLabelText("Edit compact"));
  expect(disclosure?.open).toBe(false);
  fireEvent.click(screen.getByLabelText("Edit compact"));
  expect((screen.getByLabelText("Name for compact") as HTMLInputElement).value).toBe("42");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Edit compact"));
  const confirmLeave = vi.spyOn(window, "confirm").mockReturnValue(false);
  const before = window.location.hash;
  fireEvent.click(screen.getByRole("link", { name: "compact" }));
  expect(confirmLeave).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe(before);
 });
