import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Keys } from "./Keys";

afterEach(() => {
  cleanup();
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
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("kept")).toBeTruthy();
  expect(calls).toEqual([
    "/api/keys?offset=0&limit=100",
    "/api/keys?offset=2&limit=100",
  ]);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("shows the error message when the key list request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ message: "Garage admin API is not configured" }, 502)),
  );
  renderKeys();
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
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
  expect(await screen.findByText("There are no keys.")).toBeTruthy();
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
  fireEvent.change(await screen.findByLabelText("Name for GK1"), {
    target: { value: "已有 名称" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename GK1" }));
  expect(await screen.findByText("Key renamed")).toBeTruthy();
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
  const box = (await screen.findByRole("checkbox", {
    name: "Allow create bucket for GK1",
  })) as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  expect(await screen.findByText("Garage admin API is not configured")).toBeTruthy();
  expect(box.checked).toBe(true);
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
  fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
  expect(await screen.findByText("Key deleted")).toBeTruthy();
  expect(await screen.findByText("There are no keys.")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
  expect(await screen.findByText("Key is still in use")).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("GK1");
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
