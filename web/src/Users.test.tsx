import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Users } from "./Users";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

type Row = {
  id: number;
  username: string;
  role: "admin" | "viewer";
  can_download: boolean;
  can_share: boolean;
  disabled: boolean;
  password_hash?: string;
  created_at?: number;
};

type Call = {
  url: string;
  init: RequestInit | undefined;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderUsers() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Users selfUsername="Ada" />
    </QueryClientProvider>,
  );
  return client;
}

function installApi(seed: Row[], rejectPatch = false) {
  const accounts = seed.map((row) => ({ ...row }));
  const calls: Call[] = [];
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, init });
      if (url === "/api/users" && method === "GET") {
        return json(accounts);
      }
      if (url === "/api/users" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          username: string;
          password: string;
          role: "admin" | "viewer";
          can_download: boolean;
          can_share: boolean;
        };
        if (accounts.some((row) => row.username === body.username)) {
          return json({ message: "Username is already in use" }, 409);
        }
        const created = {
          id: accounts.reduce((max, row) => Math.max(max, row.id), 0) + 1,
          username: body.username,
          role: body.role,
          can_download: body.can_download,
          can_share: body.can_share,
          disabled: false,
        };
        accounts.push(created);
        return json(created, 201);
      }
      const reset = url.match(/^\/api\/users\/(\d+)\/reset-password$/);
      if (reset && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { password: string };
        if (body.password.length < 10) {
          return json({ message: "Password must be 10 to 72 characters and not blank" }, 400);
        }
        return new Response(null, { status: 204 });
      }
      const one = url.match(/^\/api\/users\/(\d+)$/);
      if (one && method === "PATCH") {
        if (rejectPatch) {
          return json({ message: "The last enabled administrator cannot be removed" }, 400);
        }
        const row = accounts.find((item) => item.id === Number(one[1]));
        if (!row) {
          return json({ message: "Not found" }, 404);
        }
        const body = JSON.parse(String(init?.body)) as Partial<Row>;
        if (body.role === "admin" || body.role === "viewer") {
          row.role = body.role;
        }
        if (typeof body.can_download === "boolean") {
          row.can_download = body.can_download;
        }
        if (typeof body.can_share === "boolean") {
          row.can_share = body.can_share;
        }
        if (typeof body.disabled === "boolean") {
          row.disabled = body.disabled;
        }
        if (row.role === "admin" || !row.can_download) {
          row.can_share = false;
        }
        if (row.role === "admin") {
          row.can_download = false;
        }
        return json(row);
      }
      if (one && method === "DELETE") {
        const index = accounts.findIndex((item) => item.id === Number(one[1]));
        if (index < 0) {
          return json({ message: "Not found" }, 404);
        }
        accounts.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  return calls;
}

function expectAuthed(call: Call) {
  const headers = new Headers(call.init?.headers);
  expect(call.init?.credentials).toBe("include");
  expect(headers.get("x-csrf-token")).toBe("csrf-token");
}

const ada: Row = {
  id: 1,
  username: "Ada",
  role: "admin",
  can_download: false,
  can_share: false,
  disabled: false,
  password_hash: "$2b$12$should-not-render",
};

const bea: Row = {
  id: 2,
  username: "Bea",
  role: "viewer",
  can_download: true,
  can_share: true,
  disabled: false,
};

async function shown() {
  expect(await screen.findByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
}

test("lists users and never renders a password hash", async () => {
  installApi([ada, bea]);
  renderUsers();
  await shown();
  expect(document.body.textContent).not.toContain("$2b$12$should-not-render");
  expect(document.body.textContent).not.toContain("password_hash");
});

test("locks delete, role, and disable on the signed-in user", async () => {
  const calls = installApi([ada, bea]);
  renderUsers();
  await shown();
  const role = screen.getByRole("combobox", { name: "Role for Ada" }) as HTMLSelectElement;
  const disabled = screen.getByRole("checkbox", { name: "Disabled for Ada" }) as HTMLInputElement;
  const remove = screen.getByRole("button", { name: "Delete Ada" }) as HTMLButtonElement;
  const reset = screen.getByRole("button", { name: "Reset password for Ada" }) as HTMLButtonElement;
  expect(role.disabled).toBe(true);
  expect(disabled.disabled).toBe(true);
  expect(remove.disabled).toBe(true);
  expect(reset.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Role for Bea" }) as HTMLSelectElement).disabled).toBe(
    false,
  );
  fireEvent.click(remove);
  fireEvent.click(disabled);
  expect(calls.some((call) => call.init?.method === "DELETE" || call.init?.method === "PATCH")).toBe(
    false,
  );
});

test("changes role, clears share when download turns off, and disables another user", async () => {
  const calls = installApi([ada, bea]);
  renderUsers();
  await shown();
  fireEvent.change(screen.getByRole("combobox", { name: "Role for Bea" }), {
    target: { value: "admin" },
  });
  await waitFor(() => {
    const patch = calls.find((call) => call.url === "/api/users/2" && call.init?.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      role: "admin",
      can_download: false,
      can_share: false,
    });
    expectAuthed(patch as Call);
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Disabled for Bea" }));
  await waitFor(() => {
    const patch = calls.find((call) => {
      if (call.url !== "/api/users/2" || call.init?.method !== "PATCH") {
        return false;
      }
      return JSON.parse(String(call.init.body)).disabled === true;
    });
    expect(patch).toBeTruthy();
    expectAuthed(patch as Call);
  });
});

test("shows Saving while an account patch is pending and keeps the alert when it fails", async () => {
  let release: (response: Response) => void = () => {};
  const calls: Call[] = [];
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, init });
      if (url === "/api/users" && method === "GET") {
        return json([ada, bea]);
      }
      if (url === "/api/users/2" && method === "PATCH") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderUsers();
  await shown();
  expect(screen.queryByText("Saving")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Role for Bea" }), {
    target: { value: "admin" },
  });
  expect(await screen.findByText("Saving")).toBeTruthy();
  const role = screen.getByRole("combobox", { name: "Role for Bea" }) as HTMLSelectElement;
  const download = screen.getByRole("checkbox", { name: "Download for Bea" }) as HTMLInputElement;
  const share = screen.getByRole("checkbox", { name: "Share for Bea" }) as HTMLInputElement;
  const disabled = screen.getByRole("checkbox", { name: "Disabled for Bea" }) as HTMLInputElement;
  expect(role.disabled).toBe(true);
  expect(download.disabled).toBe(true);
  expect(share.disabled).toBe(true);
  expect(disabled.disabled).toBe(true);
  expect(role.value).toBe("viewer");
  const reset = screen.getByRole("button", { name: "Reset password for Bea" }) as HTMLButtonElement;
  const remove = screen.getByRole("button", { name: "Delete Bea" }) as HTMLButtonElement;
  expect(reset.textContent).toBe("Reset password for Bea");
  expect(remove.textContent).toBe("Delete Bea");
  const patch = calls.find((call) => call.url === "/api/users/2" && call.init?.method === "PATCH");
  expect(JSON.parse(String(patch?.init?.body))).toEqual({
    role: "admin",
    can_download: false,
    can_share: false,
  });
  expectAuthed(patch as Call);
  release(json({ message: "The last enabled administrator cannot be removed" }, 400));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The last enabled administrator cannot be removed",
  );
  await waitFor(() => {
    expect(screen.queryByText("Saving")).toBeNull();
  });
  expect(role.value).toBe("viewer");
  expect(reset.textContent).toBe("Reset password for Bea");
  expect(remove.textContent).toBe("Delete Bea");
});

test("turns share off with download and refuses share while download is off", async () => {
  const calls = installApi([ada, { ...bea, can_download: false, can_share: false }]);
  renderUsers();
  await shown();
  const share = screen.getByRole("checkbox", { name: "Share for Bea" }) as HTMLInputElement;
  expect(share.disabled).toBe(true);
  expect(share.checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Download for Bea" }));
  await waitFor(() => {
    const patch = calls.find((call) => call.url === "/api/users/2" && call.init?.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      can_download: true,
      can_share: false,
    });
  });
  await waitFor(() => {
    const enabled = screen.getByRole("checkbox", { name: "Share for Bea" }) as HTMLInputElement;
    expect(enabled.disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Share for Bea" }));
  await waitFor(() => {
    const box = screen.getByRole("checkbox", { name: "Share for Bea" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    const patch = calls.find((call) => {
      if (call.url !== "/api/users/2" || call.init?.method !== "PATCH") {
        return false;
      }
      return JSON.parse(String(call.init.body)).can_share === true;
    });
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ can_share: true });
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Download for Bea" }));
  await waitFor(() => {
    const patch = calls.find((call) => {
      if (call.url !== "/api/users/2" || call.init?.method !== "PATCH") {
        return false;
      }
      const body = JSON.parse(String(call.init.body)) as { can_download?: boolean };
      return body.can_download === false;
    });
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      can_download: false,
      can_share: false,
    });
  });
  await waitFor(() => {
    const box = screen.getByRole("checkbox", { name: "Share for Bea" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });
});

test("creates a user, deletes one, and resets a password with the csrf header", async () => {
  const calls = installApi([ada, bea]);
  renderUsers();
  await shown();
  const form = screen.getByRole("form", { name: "Create user" });
  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "Cara" } });
  fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(within(form).getByLabelText("Download"));
  fireEvent.click(within(form).getByLabelText("Share"));
  fireEvent.click(within(form).getByRole("button", { name: "Create user" }));
  await waitFor(() => {
    const post = calls.find((call) => call.url === "/api/users" && call.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      username: "Cara",
      password: "correct horse",
      role: "viewer",
      can_download: true,
      can_share: true,
    });
    expectAuthed(post as Call);
  });
  expect(await screen.findByText("Cara")).toBeTruthy();
  const created = screen.getByRole("form", { name: "Create user" });
  expect(within(created).getByText("User created")).toBeTruthy();
  expect((within(created).getByLabelText("Username") as HTMLInputElement).value).toBe("");
  expect((within(created).getByLabelText("Password") as HTMLInputElement).value).toBe("");

  fireEvent.change(screen.getByLabelText("New password for Bea"), {
    target: { value: "brand new secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Bea" }));
  await waitFor(() => {
    const post = calls.find(
      (call) => call.url === "/api/users/2/reset-password" && call.init?.method === "POST",
    );
    expect(JSON.parse(String(post?.init?.body))).toEqual({ password: "brand new secret" });
    expectAuthed(post as Call);
    expect((screen.getByLabelText("New password for Bea") as HTMLInputElement).value).toBe("");
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete Bea" }));
  await waitFor(() => {
    const remove = calls.find((call) => call.url === "/api/users/2" && call.init?.method === "DELETE");
    expectAuthed(remove as Call);
    expect(screen.queryByText("Bea")).toBeNull();
  });
});

test("keeps share off on the create form unless download is on", async () => {
  installApi([ada]);
  renderUsers();
  expect(await screen.findByRole("heading", { name: "Users" })).toBeTruthy();
  const form = screen.getByRole("form", { name: "Create user" });
  const download = within(form).getByLabelText("Download") as HTMLInputElement;
  const share = within(form).getByLabelText("Share") as HTMLInputElement;
  expect(share.disabled).toBe(true);
  expect(share.checked).toBe(false);
  fireEvent.click(download);
  expect(share.disabled).toBe(false);
  fireEvent.click(share);
  expect(share.checked).toBe(true);
  fireEvent.click(download);
  expect(download.checked).toBe(false);
  expect(share.checked).toBe(false);
  expect(share.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "admin" } });
  expect(download.disabled).toBe(true);
  expect(share.disabled).toBe(true);
  expect(download.checked).toBe(false);
  expect(share.checked).toBe(false);
});

test("shows the error text when a request fails", async () => {
  const calls = installApi([ada, bea], true);
  renderUsers();
  await shown();
  const form = screen.getByRole("form", { name: "Create user" });
  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "Ada" } });
  fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create user" }));
  expect((await within(form).findByRole("alert")).textContent).toBe("Username is already in use");
  expect((within(form).getByLabelText("Username") as HTMLInputElement).value).toBe("Ada");
  expect((within(form).getByLabelText("Password") as HTMLInputElement).value).toBe("correct horse");
  expect(within(form).queryByText("User created")).toBeNull();

  fireEvent.change(screen.getByLabelText("New password for Bea"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Bea" }));
  expect(await screen.findByText("Password must be 10 to 72 characters and not blank")).toBeTruthy();
  expect(calls.some((call) => call.url === "/api/users/2/reset-password")).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "Disabled for Bea" }));
  expect(
    (await screen.findByText("The last enabled administrator cannot be removed")).textContent,
  ).toBe("The last enabled administrator cannot be removed");
});

test("shows Loading users and marks the users section busy on the first load", async () => {
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
  renderUsers();
  const section = screen.getByRole("region", { name: "Users" });
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Loading users").getAttribute("role")).toBeNull();
  expect(screen.queryByText("Loading users")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no users. Create the first user.")).toBeNull();
  expect(screen.queryByText("Refreshing users")).toBeNull();
  expect(screen.getByRole("form", { name: "Create user" })).toBeTruthy();
  release(json([ada]));
  expect(await screen.findByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Users" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByLabelText("Loading users")).toBeNull();
  expect(screen.queryByText("Loading users")).toBeNull();
});

test("keeps a visible username while a later fetch refreshes the list", async () => {
  let calls = 0;
  let releaseNext: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/users");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(json([ada]));
      }
      return new Promise<Response>((resolve) => {
        releaseNext = resolve;
      });
    }),
  );
  const client = renderUsers();
  expect(await screen.findByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.queryByText("Refreshing users")).toBeNull();
  const refresh = client.refetchQueries({ queryKey: ["users"] });
  expect(await screen.findByText("Refreshing users")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.queryByLabelText("Loading users")).toBeNull();
  expect(screen.queryByText("Loading users")).toBeNull();
  expect(screen.getByRole("region", { name: "Users" }).getAttribute("aria-busy")).toBe("false");
  expect(screen.queryByRole("alert")).toBeNull();
  releaseNext(json([ada]));
  await refresh;
  await waitFor(() => {
    expect(screen.queryByText("Refreshing users")).toBeNull();
  });
  expect(screen.getByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(calls).toBe(2);
});

test("shows there are no users and keeps the create form", async () => {
  installApi([]);
  renderUsers();
  expect((await screen.findByText("There are no users. Create the first user.")).textContent).toBe(
    "There are no users. Create the first user.",
  );
  expect(screen.getByText("There are no users. Create the first user.").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("form", { name: "Create user" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Ada" })).toBeNull();
  expect(screen.queryByLabelText("Loading users")).toBeNull();
  expect(screen.queryByText("Loading users")).toBeNull();
  expect(screen.getByRole("region", { name: "Users" }).getAttribute("aria-busy")).toBe("false");
});

test("shows the API code and requests the user list again from Retry", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://ui.local");
      expect(url.pathname).toBe("/api/users");
      expect(init?.credentials).toBe("include");
      calls += 1;
      if (calls === 1) {
        return json(
          { code: "upstream_failed", message: "Garage returned an error" },
          502,
        );
      }
      return json([ada]);
    }),
  );
  renderUsers();
  expect((await screen.findByText("Garage returned an error")).textContent).toBe(
    "Garage returned an error",
  );
  expect(screen.getByText("upstream_failed").textContent).toBe("upstream_failed");
  expect(screen.getByText("upstream_failed").getAttribute("role")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("There are no users. Create the first user.")).toBeNull();
  expect(screen.getByRole("form", { name: "Create user" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.queryByText("upstream_failed")).toBeNull();
  expect(screen.queryByText("Garage returned an error")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(calls).toBe(2);
});

test("shows Ada before Zed when the API returns Zed first", async () => {
  installApi([
    {
      id: 9,
      username: "Zed",
      role: "viewer",
      can_download: false,
      can_share: false,
      disabled: false,
    },
    ada,
  ]);
  renderUsers();
  await screen.findByRole("cell", { name: "Zed" });
  const names = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  expect(names).toEqual(["Ada", "Zed"]);
});

test("sorts loaded users by created time and keeps the choice in the address", async () => {
  window.history.replaceState(null, "", "/?keep=1#users/stay");
  installApi([
    {
      id: 9,
      username: "Zed",
      role: "viewer",
      can_download: false,
      can_share: false,
      disabled: false,
      created_at: 2000,
    },
    { ...ada, created_at: 1000 },
    {
      id: 3,
      username: "Mina",
      role: "viewer",
      can_download: false,
      can_share: false,
      disabled: false,
    },
  ]);
  renderUsers();
  await screen.findByRole("cell", { name: "Zed" });
  fireEvent.change(screen.getByLabelText("Sort users"), { target: { value: "created" } });
  const names = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  expect(names).toEqual(["Ada", "Zed", "Mina"]);
  expect(window.location.search).toContain("usersSort=created");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.hash).toBe("#users/stay");
  expect((screen.getByLabelText("Sort users") as HTMLSelectElement).value).toBe("created");
});

test("filters loaded users from the query string and keeps that choice in the address", async () => {
  window.history.replaceState(null, "", "/?users=bea&keep=1&usersSort=keep-me#users/stay");
  const calls = installApi([ada, bea]);
  renderUsers();
  expect(await screen.findByRole("cell", { name: "Bea" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Ada" })).toBeNull();
  expect((screen.getByLabelText("Filter users") as HTMLInputElement).value).toBe("bea");
  expect(screen.getByText("Default order is Username.").textContent).toBe(
    "Default order is Username.",
  );
  expect(screen.queryByText("Only loaded rows")).toBeNull();
  expect(screen.getByRole("form", { name: "Create user" })).toBeTruthy();
  expect(screen.queryByText("There are no users. Create the first user.")).toBeNull();
  expect(window.location.hash).toBe("#users/stay");
  expect(window.location.search).toContain("users=bea");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.search).toContain("usersSort=keep-me");
  expect(calls).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Filter users"), { target: { value: "ADA" } });
  expect(screen.getByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Bea" })).toBeNull();
  expect(window.location.search).toContain("users=ADA");
  expect(window.location.search).toContain("keep=1");
  expect(window.location.search).toContain("usersSort=keep-me");
  expect(window.location.hash).toBe("#users/stay");
  expect(calls).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Filter users"), { target: { value: "" } });
  expect(screen.getByRole("cell", { name: "Ada" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
  expect(window.location.search).toContain("keep=1");
  expect(window.location.search).toContain("usersSort=keep-me");
  expect(window.location.search).not.toContain("users=ADA");
  expect(window.location.search).not.toContain("users=bea");
  expect(window.location.hash).toBe("#users/stay");
  expect(calls).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Filter users"), { target: { value: "admin" } });
  expect(screen.queryByRole("cell", { name: "Ada" })).toBeNull();
  expect(screen.queryByRole("cell", { name: "Bea" })).toBeNull();
  expect(screen.queryByText("There are no users. Create the first user.")).toBeNull();
  expect(screen.getByRole("form", { name: "Create user" })).toBeTruthy();
  expect(calls).toHaveLength(1);

  act(() => {
    window.history.pushState(null, "", "/?users=BEA&keep=1#users/stay");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Ada" })).toBeNull();
  expect((screen.getByLabelText("Filter users") as HTMLInputElement).value).toBe("BEA");
  expect(window.location.hash).toBe("#users/stay");
  expect(calls).toHaveLength(1);
});

test("shows Creating user while create is submitting, then User created", async () => {
  let release: (response: Response) => void = () => {};
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/users" && method === "GET") {
        return json([ada]);
      }
      if (url === "/api/users" && method === "POST") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderUsers();
  expect(await screen.findByRole("cell", { name: "Ada" })).toBeTruthy();
  const form = screen.getByRole("form", { name: "Create user" });
  fireEvent.change(within(form).getByLabelText("Username"), { target: { value: "Cara" } });
  fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create user" }));
  const pending = (await within(form).findByRole("button", {
    name: "Creating user",
  })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Creating user");
  expect((within(form).getByLabelText("Username") as HTMLInputElement).value).toBe("Cara");
  expect((within(form).getByLabelText("Password") as HTMLInputElement).value).toBe("correct horse");
  expect(within(form).queryByText("User created")).toBeNull();
  release(
    json(
      {
        id: 2,
        username: "Cara",
        role: "viewer",
        can_download: false,
        can_share: false,
        disabled: false,
      },
      201,
    ),
  );
  expect(await within(form).findByText("User created")).toBeTruthy();
  expect((within(form).getByLabelText("Username") as HTMLInputElement).value).toBe("");
  expect((within(form).getByLabelText("Password") as HTMLInputElement).value).toBe("");
  const idle = within(form).getByRole("button", { name: "Create user" }) as HTMLButtonElement;
  expect(idle.disabled).toBe(true);
  expect(idle.textContent).toBe("Create user");
});

test("shows Resetting password while reset is submitting, then Password reset", async () => {
  let release: (response: Response) => void = () => {};
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/users/2/reset-password" && method === "POST") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === "/api/users" && method === "GET") {
        return json([ada, bea]);
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderUsers();
  await shown();
  fireEvent.change(screen.getByLabelText("New password for Bea"), {
    target: { value: "brand new secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Bea" }));
  const pending = (await screen.findByRole("button", {
    name: "Resetting password",
  })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Resetting password");
  expect(screen.queryByRole("button", { name: "Reset password for Bea" })).toBeNull();
  expect((screen.getByLabelText("New password for Bea") as HTMLInputElement).value).toBe(
    "brand new secret",
  );
  const deleteBea = screen.getByRole("button", { name: "Delete Bea" }) as HTMLButtonElement;
  expect(deleteBea.disabled).toBe(true);
  expect(deleteBea.textContent).toBe("Delete Bea");
  expect(screen.queryByText("Password reset")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  release(new Response(null, { status: 204 }));
  expect(await screen.findByText("Password reset")).toBeTruthy();
  expect((screen.getByLabelText("New password for Bea") as HTMLInputElement).value).toBe("");
  const idle = screen.getByRole("button", { name: "Reset password for Bea" }) as HTMLButtonElement;
  expect(idle.disabled).toBe(true);
  expect(idle.textContent).toBe("Reset password for Bea");
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
});

test("keeps the typed password and alert when reset fails", async () => {
  let release: (response: Response) => void = () => {};
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/users/2/reset-password" && method === "POST") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === "/api/users" && method === "GET") {
        return json([ada, bea]);
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderUsers();
  await shown();
  fireEvent.change(screen.getByLabelText("New password for Bea"), {
    target: { value: "brand new secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Bea" }));
  const pending = (await screen.findByRole("button", {
    name: "Resetting password",
  })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  release(json({ message: "Password was rejected" }, 400));
  expect((await screen.findByRole("alert")).textContent).toBe("Password was rejected");
  expect((screen.getByLabelText("New password for Bea") as HTMLInputElement).value).toBe(
    "brand new secret",
  );
  expect(screen.queryByText("Password reset")).toBeNull();
  const idle = (await screen.findByRole("button", {
    name: "Reset password for Bea",
  })) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Reset password for Bea");
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
});

test("shows Deleting while delete is submitting and keeps the row when it fails", async () => {
  let release: (response: Response) => void = () => {};
  document.cookie = "garage_csrf=csrf-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/users/2" && method === "DELETE") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === "/api/users" && method === "GET") {
        return json([ada, bea]);
      }
      return json({ message: "unexpected" }, 500);
    }),
  );
  renderUsers();
  await shown();
  fireEvent.click(screen.getByRole("button", { name: "Delete Bea" }));
  const pending = (await screen.findByRole("button", { name: "Deleting Bea" })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Deleting Bea");
  expect(screen.queryByRole("button", { name: "Delete Bea" })).toBeNull();
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
  const reset = screen.getByRole("button", { name: "Reset password for Bea" }) as HTMLButtonElement;
  expect(reset.disabled).toBe(true);
  expect(reset.textContent).toBe("Reset password for Bea");
  expect(screen.queryByRole("dialog")).toBeNull();
  release(json({ message: "The user still owns a bucket" }, 409));
  expect((await screen.findByRole("alert")).textContent).toBe("The user still owns a bucket");
  expect(screen.getByRole("cell", { name: "Bea" })).toBeTruthy();
  const idle = (await screen.findByRole("button", { name: "Delete Bea" })) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Delete Bea");
  expect(screen.queryByRole("dialog")).toBeNull();
});
