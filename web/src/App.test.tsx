import { GarageTheme } from "./theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { App, decodeObjectKey, encodeObjectKey, folderNameAllowed } from "./App";
import { setFormDirty } from "./unsaved";
import { api } from "./api/client";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterAll(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "garage_csrf=; Max-Age=0";
});

function sectionsNav() {
  return within(screen.getByRole("navigation", { name: "Sections" }));
}

async function findSectionLink(name: string) {
  const nav = within(await screen.findByRole("navigation", { name: "Sections" }));
  return nav.findByRole("link", { name });
}

async function chooseSection(name: string) {
  const link = await findSectionLink(name);
  await act(async () => { fireEvent.click(link); });
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GarageTheme><App /></GarageTheme>
    </QueryClientProvider>,
  );
}

function capabilitiesResponse() {
  return new Response(
    JSON.stringify({
      version: "20261010.1",
      listBucketsInfo: "unknown",
      listKeysInfo: "unknown",
    }),
    { status: 200 },
  );
}

test("shows health status when the session is authenticated", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: / · (admin|viewer)$/ }));
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Ada · admin" })).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
  expect(screen.getAllByText("Garage version is not set")).toHaveLength(1);
  await chooseSection("Settings");
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getAllByText("Garage version is not set")).toHaveLength(2);
  expect(setItem).not.toHaveBeenCalled();
});

test("shows the setup form before initialization and does not use storage", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
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

test("shows why a short setup password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
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
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows why a short login password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    return new Response(
      JSON.stringify({
        initialized: true,
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
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows Logging in on the disabled login button and keeps the typed credentials when login fails", async () => {
  let releaseLogin: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/login")) {
        return new Promise<Response>((resolve) => {
          releaseLogin = resolve;
        });
      }
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: false,
          username: null,
          role: null,
          can_download: null,
          can_share: null,
        }),
        { status: 200 },
      );
    }),
  );
  renderApp();
  const username = (await screen.findByLabelText("Username")) as HTMLInputElement;
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  const idle = screen.getByRole("button", { name: "Log in" }) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Log in");
  fireEvent.change(username, { target: { value: "Ada" } });
  fireEvent.change(password, { target: { value: "correct horse" } });
  fireEvent.click(idle);
  const pending = (await screen.findByRole("button", { name: "Logging in" })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Logging in");
  expect(username.value).toBe("Ada");
  expect(password.value).toBe("correct horse");
  expect(screen.queryByText("Invalid username or password")).toBeNull();
  const finish = releaseLogin;
  if (!finish) {
    throw new Error("login did not start");
  }
  finish(
    new Response(JSON.stringify({ message: "Invalid username or password" }), { status: 401 }),
  );
  expect(await screen.findByText("Invalid username or password")).toBeTruthy();
  expect(username.value).toBe("Ada");
  expect(password.value).toBe("correct horse");
  const again = screen.getByRole("button", { name: "Log in" }) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(again.textContent).toBe("Log in");
  expect(screen.queryByRole("button", { name: "Logging in" })).toBeNull();
});

test("shows Creating administrator on the disabled setup button and keeps the typed values when setup fails", async () => {
  let releaseSetup: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/setup")) {
        return new Promise<Response>((resolve) => {
          releaseSetup = resolve;
        });
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
    }),
  );
  renderApp();
  const username = (await screen.findByLabelText("Username")) as HTMLInputElement;
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  const idle = screen.getByRole("button", { name: "Create administrator" }) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Create administrator");
  fireEvent.change(username, { target: { value: "Ada" } });
  fireEvent.change(password, { target: { value: "correct horse" } });
  fireEvent.click(idle);
  const pending = (await screen.findByRole("button", {
    name: "Creating administrator",
  })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Creating administrator");
  expect(username.value).toBe("Ada");
  expect(password.value).toBe("correct horse");
  expect(screen.queryByText("Could not create the administrator")).toBeNull();
  const finish = releaseSetup;
  if (!finish) {
    throw new Error("setup did not start");
  }
  finish(
    new Response(JSON.stringify({ message: "Could not create the administrator" }), {
      status: 400,
    }),
  );
  expect(await screen.findByText("Could not create the administrator")).toBeTruthy();
  expect(username.value).toBe("Ada");
  expect(password.value).toBe("correct horse");
  const again = screen.getByRole("button", { name: "Create administrator" }) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(again.textContent).toBe("Create administrator");
  expect(screen.queryByRole("button", { name: "Creating administrator" })).toBeNull();
});

test("shows Logging out on the disabled logout button until logout fails", async () => {
  document.cookie = "garage_csrf=csrf-token";
  let releaseLogout: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/status")) {
        return sessionResponse("viewer");
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/auth/logout")) {
        return new Promise<Response>((resolve) => {
          releaseLogout = resolve;
        });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: "Bea · viewer" }));
  const idle = (await screen.findByRole("button", { name: "Log out" })) as HTMLButtonElement;
  expect(idle.disabled).toBe(false);
  expect(idle.textContent).toBe("Log out");
  fireEvent.click(idle);
  const pending = (await screen.findByRole("button", {
    name: "Logging out",
  })) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Logging out");
  expect(screen.getByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  const finish = releaseLogout;
  if (!finish) {
    throw new Error("logout did not start");
  }
  finish(new Response(JSON.stringify({ message: "Logout failed" }), { status: 500 }));
  const again = (await screen.findByRole("button", { name: "Log out" })) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
  expect(again.textContent).toBe("Log out");
  expect(screen.queryByRole("button", { name: "Logging out" })).toBeNull();
  expect(screen.getByRole("button", { name: "Bea · viewer" })).toBeTruthy();
});

test("password form shows unsaved, saving, saved, and failed", async () => {
  document.cookie = "garage_csrf=csrf-token";
  let mode: "hold" | "fail" = "hold";
  let releaseSave: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/status")) {
        return sessionResponse("viewer");
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/auth/change-password")) {
        if (mode === "fail") {
          return new Response(JSON.stringify({ message: "Wrong password" }), { status: 400 });
        }
        return new Promise<Response>((resolve) => {
          releaseSave = resolve;
        });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  await chooseSection("Settings");
  const current = (await screen.findByLabelText("Current password")) as HTMLInputElement;
  const next = screen.getByLabelText("New password") as HTMLInputElement;
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(current, { target: { value: "current secret" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.change(current, { target: { value: "" } });
  fireEvent.change(next, { target: { value: "" } });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  fireEvent.change(current, { target: { value: "current secret" } });
  fireEvent.change(next, { target: { value: "new password1" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Saving")).toBeTruthy();
  const pending = screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.textContent).toBe("Change password");
  const finish = releaseSave;
  if (!finish) {
    throw new Error("password save did not start");
  }
  finish(new Response(JSON.stringify({}), { status: 200 }));
  expect(await screen.findByText("Password updated")).toBeTruthy();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByText("Saving")).toBeNull();
  expect(current.value).toBe("");
  expect(next.value).toBe("");
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();

  mode = "fail";
  fireEvent.change(current, { target: { value: "current secret" } });
  fireEvent.change(next, { target: { value: "new password1" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Wrong password")).toBeTruthy();
  expect(screen.getByText("Save failed")).toBeTruthy();
  expect(current.value).toBe("current secret");
  expect(next.value).toBe("new password1");
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
});

test("a cancelled confirm keeps the hash and a dirty password does not replace onbeforeunload", async () => {
  const uploadGuard = () => "upload";
  window.onbeforeunload = uploadGuard;
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  window.location.hash = "#settings";
  stubSignedIn("admin");
  renderApp();
  const current = (await screen.findByLabelText("Current password")) as HTMLInputElement;
  const cleanLeave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanLeave);
  expect(cleanLeave.defaultPrevented).toBe(false);
  expect(window.onbeforeunload).toBe(uploadGuard);
  fireEvent.change(current, { target: { value: "current secret" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(window.onbeforeunload).toBe(uploadGuard);
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  fireEvent.click(sectionsNav().getByRole("link", { name: "Keys" }));
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe("#settings");
  expect(current.value).toBe("current secret");
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  window.location.hash = "#keys";
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  expect(window.location.hash).toBe("#settings");
  expect(current.value).toBe("current secret");
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  expect(confirm).toHaveBeenCalledTimes(2);
  window.onbeforeunload = null;
});

test("an accepted leave does not ask again after the password form unmounts", async () => {
  window.location.hash = "#settings/extra";
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  stubSignedIn("admin");
  renderApp();
  const current = (await screen.findByLabelText("Current password")) as HTMLInputElement;
  fireEvent.change(current, { target: { value: "current secret" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Settings" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe("#settings");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
    "current secret",
  );

  fireEvent.click(sectionsNav().getByRole("link", { name: "Buckets" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe("#buckets");
  expect(screen.queryByLabelText("Current password")).toBeNull();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Settings" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(window.location.hash).toBe("#settings");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
    "current secret",
  );
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Buckets" }));
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(window.location.hash).toBe("#buckets");
});

test("a hashchange that arrives after returning to the dirty password form does not ask", async () => {
  window.location.hash = "#settings";
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  stubSignedIn("admin");
  renderApp();
  const current = (await screen.findByLabelText("Current password")) as HTMLInputElement;
  fireEvent.change(current, { target: { value: "current secret" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Buckets" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe("#buckets");
  expect(screen.queryByLabelText("Current password")).toBeNull();

  fireEvent.click(sectionsNav().getByRole("link", { name: "Settings" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe("#settings");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
    "current secret",
  );
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe("#settings");
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
    "current secret",
  );

  fireEvent.click(sectionsNav().getByRole("link", { name: "Buckets" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledWith("Leave this page? Unsaved changes will be lost.");
  expect(window.location.hash).toBe("#buckets");
  expect(screen.queryByLabelText("Current password")).toBeNull();
});

test("shows why a short new password did not submit", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: "Bea",
          role: "viewer",
          can_download: false,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  await chooseSection("Settings");
  fireEvent.change(await screen.findByLabelText("Current password"), {
    target: { value: "current secret" },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Password must be 10 to 72 characters")).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/setup"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/login"))).toBe(
    false,
  );
  expect(
    fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/change-password")),
  ).toBe(false);
});

test("shows a blocking notice when Garage is older than v2.3.0", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/status")) {
        return new Response(
          JSON.stringify({
            initialized: true,
            authenticated: true,
            username: "Ada",
            role: "admin",
            can_download: true,
            can_share: true,
            garage_version: "v2.2.0",
            garage_write_blocked: true,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/metrics")) {
        return new Response(
          JSON.stringify({ s3Requests: 0, s3Errors: 0, blockReadBytes: 0, blockWriteBytes: 0 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe("Garage v2.3.0 or newer is required");
  expect(screen.getByRole("button", { name: "Ada · admin" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: / · (admin|viewer)$/ }));
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(1);
  await chooseSection("Keys");
  expect(await screen.findByText("Keys are unavailable")).toBeTruthy();
  expect(screen.queryByText("Garage v2.3.0 or newer is required")).toBeNull();
});

test("shows a TLS warning while verification is off", async () => {
  async function signIn(tlsInsecure: boolean) {
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/capabilities")) {
          return capabilitiesResponse();
        }
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
              tls_insecure: tlsInsecure,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/cluster/status")) {
          return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }),
    );
    renderApp();
    expect(await screen.findByRole("button", { name: "Ada · admin" })).toBeTruthy();
  }

  await signIn(true);
  expect(screen.getByRole("alert").textContent).toBe("TLS certificate verification is off.");

  await chooseSection("Buckets");
  expect(screen.queryByText("TLS certificate verification is off.")).toBeNull();

  await signIn(false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("TLS certificate verification is off.")).toBeNull();
});

test("shows user management for an admin and locks that signed-in row", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/users")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 7,
                username: "Ada",
                role: "admin",
                can_download: false,
                can_share: false,
                disabled: false,
                password_hash: "$2b$12$from-the-api",
              },
            ],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  fireEvent.click(await screen.findByRole("button", { name: / · (admin|viewer)$/ }));
  expect(await screen.findByText("ok · test")).toBeTruthy();
  await chooseSection("Settings");
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(2);
  await chooseSection("Users");
  fireEvent.click(await screen.findByRole("button", { name: "Actions: Ada" }));
  const remove = (await screen.findByRole("button", { name: "Delete Ada" })) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Role for Ada" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("checkbox", { name: "Disabled for Ada" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(document.body.textContent).not.toContain("$2b$12$from-the-api");
});

test("hides user management from a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: "Bea",
          role: "viewer",
          can_download: false,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: / · (admin|viewer)$/ }));
  expect(await screen.findByText("ok · test")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  await chooseSection("Settings");
  expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
  expect(await screen.findByText("Version 20261010.1")).toBeTruthy();
  expect(screen.getByText("List buckets info unknown")).toBeTruthy();
  expect(screen.getByText("List keys info unknown")).toBeTruthy();
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
});

test("shows a bucket id and its alias to an admin", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
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
      if (url.includes("/api/users")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "bucket-ada", globalAliases: ["a&b=c"] }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/keys")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "key-ada", name: "ada-key", secretAccessKey: "SECRETADA" }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
  renderApp();
  await chooseSection("Buckets");
  expect(await screen.findByText("bucket-ada", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("a&b=c")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await chooseSection("Users");
  expect(screen.getByRole("heading", { name: "Users" })).toBeTruthy();
  await chooseSection("Keys");
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByText("ada-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByLabelText("Actions (key-ada)"));
  expect(screen.getByRole("button", { name: "Save name (key-ada)" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Allow bucket creation (key-ada)" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("button", { name: "Delete key-ada" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show secret (key-ada)" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETADA");
});

test("shows a bucket id to a viewer", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: "Bea",
          role: "viewer",
          can_download: false,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/healthz")) {
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }
    if (url.includes("/api/buckets")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "bucket-bea", localAliases: ["west"] }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/keys")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "key-bea", name: "bea-key", secretAccessKey: "SECRETBEa" }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(sectionsNav().queryByRole("link", { name: "Users" })).toBeNull();
  await chooseSection("Buckets");
  expect(await screen.findByText("bucket-bea", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("west")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete bucket-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add alias to bucket-bea" })).toBeNull();
  await chooseSection("Keys");
  expect(await screen.findByText("key-bea")).toBeTruthy();
  expect(screen.getByText("bea-key")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRETBEa");
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/users"))).toBe(false);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/health"))).toBe(
    false,
  );
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cluster/status"))).toBe(
    false,
  );
  expect(screen.queryByRole("heading", { name: "Cluster health" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Nodes" })).toBeNull();
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/keys"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename key-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete key-bea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show secret (key-bea)" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Allow create bucket for key-bea" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter((call) => {
      const method = methodOf(call).toUpperCase();
      return method !== "GET" && String(call[0]).includes("/api/keys");
    }),
  ).toEqual([]);
  expect(
    fetchMock.mock.calls.filter((call) => {
      const method = methodOf(call).toUpperCase();
      return method !== "GET" && String(call[0]).includes("/api/buckets");
    }),
  ).toEqual([]);
});

function sessionResponse(role: "admin" | "viewer") {
  const admin = role === "admin";
  return new Response(
    JSON.stringify({
      initialized: true,
      authenticated: true,
      username: admin ? "Ada" : "Bea",
      role,
      can_download: admin,
      can_share: admin,
      garage_version: "v2.4.1",
      garage_write_blocked: false,
    }),
    { status: 200 },
  );
}

function stubSignedIn(role: "admin" | "viewer") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      if (url.includes("/api/auth/status")) {
        return sessionResponse(role);
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "bucket-ada", globalAliases: ["pictures"] }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/keys")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "key-ada", name: "ada-key" }],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/users")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/cluster/status")) {
        return new Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    }),
  );
}

test("the Buckets nav action sets exactly #buckets", async () => {
  window.location.hash = "#buckets/bucket-ada/photos/2024/";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("button", { name: "Back to buckets" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bucket" })).toBeNull();
  await chooseSection("Buckets");
  expect(window.location.hash).toBe("#buckets");
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  expect(screen.getByRole("button", { name: "Create bucket" })).toBeTruthy();
  expect(screen.getByText("bucket-ada", { selector: "code" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back to buckets" })).toBeNull();
});

test("choosing Keys hides the buckets section and sets the hash", async () => {
  window.location.hash = "#buckets";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByText("bucket-ada", { selector: "code" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Buckets" })).toBeTruthy();
  await chooseSection("Keys");
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.queryByText("bucket-ada", { selector: "code" })).toBeNull();
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(window.location.hash).toBe("#keys");
});

test("loading #keys shows keys", async () => {
  window.location.hash = "#keys";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Keys" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Bea · viewer" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Bea · viewer" }));
  expect(screen.getAllByText("Garage v2.4.1")).toHaveLength(1);
});

test("an admin sees Users and a viewer opening #users sees overview", async () => {
  stubSignedIn("admin");
  renderApp();
  expect(await findSectionLink("Users")).toBeTruthy();
  cleanup();

  window.location.hash = "#users";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  expect(sectionsNav().queryByRole("link", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
});

test("a non-admin #users/x stays on overview and keeps the hash", async () => {
  window.location.hash = "#users/x";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  expect(sectionsNav().queryByRole("link", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(window.location.hash).toBe("#users/x");
});

test("an unknown hash shows overview", async () => {
  window.location.hash = "#layout";
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("button", { name: "Ada · admin" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Buckets" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Keys" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
});

test("mobile Menu toggles the drawer links", async () => {
  stubNavMedia(true);
  stubSignedIn("admin");
  renderApp();
  const menu = await screen.findByRole("button", { name: "Menu" });
  fireEvent.click(menu);
  expect(sectionsNav().getByRole("link", { name: "Buckets" })).toBeTruthy();
  expect(sectionsNav().getByRole("link", { name: "Keys" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
  expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  fireEvent.click(menu);
  await chooseSection("Keys");
  expect(await screen.findByText("key-ada")).toBeTruthy();
  expect(window.location.hash).toBe("#keys");
});

function stubNavMedia(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const media: MediaQueryList = {
      matches: query === "(max-width: 899px)" && narrow,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    };
    return media;
  });
}

test("a viewport below 900px hides section links until Menu opens them", async () => {
  stubNavMedia(true);
  stubSignedIn("admin");
  renderApp();
  expect(await screen.findByRole("button", { name: "Menu" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  expect(sectionsNav().getByRole("link", { name: "Buckets" })).toBeTruthy();

  cleanup();
  stubNavMedia(false);
  renderApp();
  expect(await findSectionLink("Buckets")).toBeTruthy();
});

test("the mobile detail parent link preserves the unsaved navigation guard", async () => {
  stubNavMedia(true);
  stubSignedIn("admin");
  window.location.hash = "#buckets/bucket-ada/photos/2024/";
  renderApp();
  const back = await screen.findByRole("link", { name: "← Buckets" });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  setFormDirty("mobile-parent-test", true);
  try {
    fireEvent.click(back);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#buckets/bucket-ada/photos/2024/");
    confirm.mockReturnValue(true);
    fireEvent.click(back);
    expect(window.location.hash).toBe("#buckets");
  } finally {
    setFormDirty("mobile-parent-test", false);
  }
});

test("a signed-in page shows one breadcrumb built from the section labels", async () => {
  stubSignedIn("admin");
  renderApp();
  const overview = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(screen.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
  expect(within(overview).queryByRole("link")).toBeNull();
  expect(
    within(overview).getByText("Overview", { selector: "[aria-current='page']" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ada · admin" }));
  const version = screen.getAllByText("Garage v2.4.1")[0];
  expect(overview.closest("header")).toBeTruthy();
  expect(version.closest(".console-health")).toBeTruthy();
  expect(
    overview.compareDocumentPosition(screen.getByRole("heading", { name: "Cluster health" })),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

  cleanup();
  window.location.hash = "#keys";
  renderApp();
  const keys = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(within(keys).getByRole("link", { name: "Overview" })).toBeTruthy();
  expect(within(keys).queryByRole("link", { name: "Keys" })).toBeNull();
  expect(within(keys).getByText("Keys", { selector: "[aria-current='page']" })).toBeTruthy();
  const keysHeading = await screen.findByRole("heading", { name: "Keys" });
  expect(keys.closest("header")).toBeTruthy();
  expect(document.getElementById("main-content")?.contains(keysHeading)).toBe(true);
  fireEvent.click(within(keys).getByRole("link", { name: "Overview" }));
  expect(window.location.hash).toBe("#overview");

  cleanup();
  window.location.hash = "#buckets";
  renderApp();
  const buckets = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(within(buckets).getByRole("link", { name: "Overview" })).toBeTruthy();
  expect(within(buckets).queryByRole("link", { name: "Buckets" })).toBeNull();
  expect(within(buckets).getByText("Buckets", { selector: "[aria-current='page']" })).toBeTruthy();

  cleanup();
  window.location.hash = "#buckets/bucket-ada/photos/2024/";
  renderApp();
  const objects = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(within(objects).getByRole("link", { name: "Overview" })).toBeTruthy();
  expect(within(objects).getByRole("link", { name: "Buckets" })).toBeTruthy();
  expect(within(objects).queryByRole("link", { name: "Objects" })).toBeNull();
  expect(within(objects).getByText("Objects", { selector: "[aria-current='page']" })).toBeTruthy();
  expect(objects.textContent).not.toContain("bucket-ada");
  expect(objects.textContent).not.toContain("photos");
  expect(objects.textContent).not.toContain("2024");
  fireEvent.click(within(objects).getByRole("link", { name: "Buckets" }));
  expect(window.location.hash).toBe("#buckets");

  cleanup();
  window.location.hash = "#users";
  renderApp();
  const users = await screen.findByRole("navigation", { name: "Breadcrumb" });
  expect(within(users).getByRole("link", { name: "Overview" })).toBeTruthy();
  expect(within(users).queryByRole("link", { name: "Users" })).toBeNull();
  expect(within(users).getByText("Users", { selector: "[aria-current='page']" })).toBeTruthy();

  cleanup();
  window.location.hash = "#users";
  stubSignedIn("viewer");
  renderApp();
  expect(await screen.findByRole("button", { name: "Bea · viewer" })).toBeTruthy();
  const viewer = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(viewer).queryByRole("link")).toBeNull();
  expect(within(viewer).getByText("Overview", { selector: "[aria-current='page']" })).toBeTruthy();
  expect(viewer.textContent).not.toContain("Users");
});

function methodOf(call: readonly unknown[]): string {
  const init = call[1];
  if (typeof init !== "object" || init === null || !("method" in init)) {
    return "GET";
  }
  return typeof init.method === "string" ? init.method : "GET";
}

test("encodes each object key segment and allows the spec folder names", () => {
  expect(encodeObjectKey("a?b#c%20d=e")).toBe("a%3Fb%23c%2520d%3De");
  expect(decodeObjectKey("a%3Fb%23c%2520d%3De")).toBe("a?b#c%20d=e");
  expect(encodeObjectKey("报告.txt")).toBe("%E6%8A%A5%E5%91%8A.txt");
  expect(decodeObjectKey("%E6%8A%A5%E5%91%8A.txt")).toBe("报告.txt");
  expect(encodeObjectKey("dir/报告.txt")).toBe("dir/%E6%8A%A5%E5%91%8A.txt");
  expect(decodeObjectKey("dir/%E6%8A%A5%E5%91%8A.txt")).toBe("dir/报告.txt");
  expect(folderNameAllowed("a?b#c%20d=e")).toBe(true);
  expect(folderNameAllowed("报告.txt")).toBe(true);
  expect(folderNameAllowed("a b")).toBe(true);
  expect(folderNameAllowed("=#?% ")).toBe(true);
  expect(folderNameAllowed("a/b")).toBe(false);
  expect(folderNameAllowed("a\nb")).toBe(false);
  expect(folderNameAllowed("a\u0000b")).toBe(false);
});

function objectBrowserResponse(role: "admin" | "viewer", canDownload: boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/capabilities")) {
      return capabilitiesResponse();
    }
    if (url.includes("/api/auth/status")) {
      return new Response(
        JSON.stringify({
          initialized: true,
          authenticated: true,
          username: role === "admin" ? "Ada" : "Bea",
          role,
          can_download: canDownload,
          can_share: false,
          garage_version: "v2.4.1",
          garage_write_blocked: false,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/healthz")) {
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }
    if (url.includes("/objects/a.txt")) {
      if (url.includes("preview=1")) {
        return new Response("plain body of a.txt", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          key: "a.txt",
          size: 1,
          etag: "abc",
          lastModified: "2026-10-11T00:00:00Z",
          contentType: "text/plain",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/objects")) {
      return new Response(
        JSON.stringify({
          prefix: "",
          entries: [
            { kind: "prefix", prefix: "photos/" },
            {
              kind: "object",
              key: "a.txt",
              size: 1,
              etag: "abc",
              lastModified: "2026-10-11T00:00:00Z",
            },
          ],
          next: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/buckets")) {
      return new Response(
        JSON.stringify({
          items: [{ id: "bucket-bea", globalAliases: ["west"] }],
          hasMore: false,
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 500 });
  });
}

test("a viewer without download does not see preview or write controls", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("viewer", false));
  renderApp();
  expect(await screen.findByRole("button", { name: "a.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "photos/" })).toBeTruthy();
  expect(screen.getByLabelText("Search")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Delete folder/ })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  expect(screen.queryByText("plain body of a.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
  expect(await screen.findByText("Content type text/plain")).toBeTruthy();
  expect(screen.queryByText("plain body of a.txt")).toBeNull();
});

test("a viewer with download sees preview and download but not write controls", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("viewer", true));
  renderApp();
  fireEvent.click(await screen.findByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect((await screen.findByText("plain body of a.txt")).tagName).toBe("PRE");
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    "/api/buckets/bucket-bea/objects/a.txt?download=1",
  );
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("target")).toBe("_blank");
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("rel")).toBe("noopener");
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Delete folder/ })).toBeNull();
  expect(screen.queryByRole("region", { name: "Upload" })).toBeNull();
});

test("shows one Garage banner when the bucket list is down and clears it after Retry", async () => {
  window.location.hash = "#buckets";
  let bucketCalls = 0;
  let healthCalls = 0;
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
            garage_version: "v2.4.1",
            garage_write_blocked: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/healthz")) {
        healthCalls += 1;
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        bucketCalls += 1;
        if (bucketCalls === 1) {
          return new Response(
            JSON.stringify({
              code: "garage_unavailable",
              message: "Garage admin API is not reachable",
            }),
            { status: 502 },
          );
        }
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    }),
  );
  renderApp();
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage admin API is not reachable");
  const buckets = screen.getByRole("region", { name: "Buckets" });
  expect(buckets.textContent ?? "").not.toContain("garage_unavailable");
  expect(buckets.textContent ?? "").not.toContain("Garage admin API is not reachable");
  const bucketsBefore = bucketCalls;
  const healthBefore = healthCalls;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(bucketCalls).toBe(bucketsBefore + 1);
  expect(healthCalls).toBe(healthBefore);
});

test("keeps the Garage banner while a down bucket list refetch has not settled", async () => {
  window.location.hash = "#buckets";
  let bucketCalls = 0;
  let secondSettled = false;
  let releaseSecond: () => void = () => {};
  const secondResponse = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
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
            garage_version: "v2.4.1",
            garage_write_blocked: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
      }
      if (url.includes("/api/buckets")) {
        bucketCalls += 1;
        if (bucketCalls > 1) {
          await secondResponse;
          secondSettled = true;
        }
        return new Response(
          JSON.stringify({
            code: "garage_unavailable",
            message: "Garage admin API is not reachable",
          }),
          { status: 502 },
        );
      }
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 });
    }),
  );
  renderApp();
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Garage admin API is not reachable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => {
    expect(bucketCalls).toBe(2);
    expect(screen.getByRole("alert").textContent).toBe("Garage admin API is not reachable");
  });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  releaseSecond();
  await waitFor(() => {
    expect(secondSettled).toBe(true);
    expect(screen.queryByText("Loading buckets")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Garage admin API is not reachable");
  });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  const buckets = screen.getByRole("region", { name: "Buckets" });
  expect(buckets.textContent ?? "").not.toContain("garage_unavailable");
});

test("an admin with the download bit off still sees upload, delete, preview, and download", async () => {
  window.location.hash = "#buckets/bucket-bea/";
  vi.stubGlobal("fetch", objectBrowserResponse("admin", false));
  renderApp();
  fireEvent.keyDown(await screen.findByLabelText("Actions (photos/)"), { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Delete folder (photos/)" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.getByRole("region", { name: "Upload" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Preview" })).toBeNull();
  expect((await screen.findByText("plain body of a.txt")).tagName).toBe("PRE");
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
    "/api/buckets/bucket-bea/objects/a.txt?download=1",
  );
  expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("returns to the login form when a signed-in request is unauthenticated", async () => {
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
            garage_version: "v2.4.1",
            garage_write_blocked: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/cluster/health")) {
        return new Response(
          JSON.stringify({ code: "unauthenticated", message: "Login required" }),
          { status: 401 },
        );
      }
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  expect(await screen.findByRole("button", { name: "Log in" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
});

test.each(["before expiry", "after expiry"])("keeps a new login when an old 401 body finishes %s", async (requestTiming) => {
  let finishOldBody!: (body: string) => void;
  const oldBody = new Promise<string>((resolve) => { finishOldBody = resolve; });
  const session = {
    initialized: true, authenticated: true, username: "Ada", role: "admin",
    can_download: true, can_share: true, garage_version: "v2.4.1", garage_write_blocked: false,
  };
  const failure = JSON.stringify({ code: "unauthenticated", message: "Login required" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/status") return new Response(JSON.stringify(session));
    if (url === "/api/auth/login") return new Response(null, { status: 204 });
    if (url === "/api/test/expire") return new Response(failure, { status: 401 });
    if (url === "/api/test/old") {
      const response = new Response(null, { status: 401 });
      vi.spyOn(response, "text").mockImplementation(() => oldBody);
      return response;
    }
    if (url.includes("/api/capabilities")) return capabilitiesResponse();
    if (url === "/api/cluster/status") return new Response(JSON.stringify({ nodes: [] }));
    return new Response(JSON.stringify({ status: "ok", version: "test" }));
  }));
  renderApp();
  await screen.findByRole("navigation", { name: "Sections" });
  let oldRequest: Promise<unknown>;
  if (requestTiming === "before expiry") oldRequest = api("/api/test/old").catch((error: unknown) => error);
  await act(async () => { await api("/api/test/expire").catch(() => undefined); });
  await screen.findByRole("button", { name: "Log in" });
  if (requestTiming === "after expiry") oldRequest = api("/api/test/old").catch((error: unknown) => error);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  await screen.findByRole("navigation", { name: "Sections" });
  await act(async () => {
    finishOldBody(failure);
    expect(await oldRequest).toBeInstanceOf(Error);
  });
  expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  await act(async () => { await api("/api/test/expire").catch(() => undefined); });
  expect(await screen.findByRole("button", { name: "Log in" })).toBeTruthy();
});

test("a delayed raw key-list 401 cannot clear a new login", async () => {
  window.location.hash = "#keys";
  let finishOldBody!: (body: string) => void;
  const oldBody = new Promise<string>((resolve) => { finishOldBody = resolve; });
  let keysStarted = false;
  const failure = JSON.stringify({ code: "unauthenticated", message: "Login required" });
  stubSignedIn("admin");
  const signedInFetch = fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/keys?") && !keysStarted) {
      keysStarted = true;
      const response = new Response(null, { status: 401 });
      vi.spyOn(response, "text").mockImplementation(() => oldBody);
      return response;
    }
    if (url === "/api/test/expire") return new Response(failure, { status: 401 });
    if (url === "/api/auth/login") return new Response(null, { status: 204 });
    return signedInFetch(input, init);
  }));
  renderApp();
  await waitFor(() => { expect(keysStarted).toBe(true); });
  await act(async () => { await api("/api/test/expire").catch(() => undefined); });
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  await screen.findByRole("navigation", { name: "Sections" });
  await act(async () => { finishOldBody(failure); await oldBody; });
  expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
});

test("changing the password preserves the replacement session when an old request returns 401", async () => {
  let finishOldBody!: (body: string) => void;
  const oldBody = new Promise<string>((resolve) => { finishOldBody = resolve; });
  stubSignedIn("viewer");
  const signedInFetch = fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/test/old") {
      const response = new Response(null, { status: 401 });
      vi.spyOn(response, "text").mockImplementation(() => oldBody);
      return response;
    }
    if (url === "/api/auth/change-password") return new Response(null, { status: 204 });
    return signedInFetch(input, init);
  }));
  renderApp();
  await chooseSection("Settings");
  const oldRequest = api("/api/test/old").catch((error: unknown) => error);
  fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "current secret" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await waitFor(() => { expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(""); });
  await act(async () => {
    finishOldBody(JSON.stringify({ code: "unauthenticated", message: "Login required" }));
    expect(await oldRequest).toBeInstanceOf(Error);
  });
  expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
});

test("keeps the change-password form when the current password is rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/change-password")) {
        return new Response(
          JSON.stringify({ code: "invalid_credentials", message: "Invalid credentials" }),
          { status: 401 },
        );
      }
      if (url.includes("/api/auth/status")) {
        return new Response(
          JSON.stringify({
            initialized: true,
            authenticated: true,
            username: "Bea",
            role: "viewer",
            can_download: false,
            can_share: false,
            garage_version: null,
            garage_write_blocked: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/capabilities")) {
        return capabilitiesResponse();
      }
      return new Response(JSON.stringify({ status: "ok", version: "test" }), { status: 200 });
    }),
  );
  renderApp();
  await chooseSection("Settings");
  fireEvent.change(await screen.findByLabelText("Current password"), {
    target: { value: "current secret" },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Invalid credentials")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
});

test("viewer overview has guarded Buckets and Keys entry points in the main work area", async () => {
  stubSignedIn("viewer");
  renderApp();
  await screen.findByRole("button", { name: "Bea · viewer" });
  const main = within(screen.getByRole("main"));
  expect(main.getByRole("heading", { name: "Overview" })).toBeTruthy();
  const buckets = main.getByRole("link", { name: "Buckets" });
  expect(buckets.getAttribute("href")).toBe("#buckets");
  expect(main.getByRole("link", { name: "Keys" }).getAttribute("href")).toBe("#keys");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  setFormDirty("viewer-overview-regression", true);
  try {
    fireEvent.click(buckets);
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("");
    expect(main.getByRole("heading", { name: "Overview" })).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(buckets);
    expect(window.location.hash).toBe("#buckets");
    expect(await screen.findByText("bucket-ada", { selector: "code" })).toBeTruthy();
  } finally {
    setFormDirty("viewer-overview-regression", false);
  }
  await chooseSection("Overview");
  fireEvent.click(within(screen.getByRole("main")).getByRole("link", { name: "Keys" }));
  expect(window.location.hash).toBe("#keys");
  expect(await screen.findByText("key-ada")).toBeTruthy();
});
