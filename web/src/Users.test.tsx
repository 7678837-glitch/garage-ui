import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Users } from "./Users";

afterEach(() => {
  cleanup();
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

  fireEvent.change(screen.getByLabelText("New password for Bea"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password for Bea" }));
  expect(await screen.findByText("Password must be 10 to 72 characters and not blank")).toBeTruthy();
  expect(calls.some((call) => call.url === "/api/users/2/reset-password")).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "Disabled for Bea" }));
  expect(
    (await screen.findByText("The last enabled administrator cannot be removed")).textContent,
  ).toBe("The last enabled administrator cannot be removed");
});
