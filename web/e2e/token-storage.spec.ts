import { expect, type Page, type Response, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { administrator } from "./accounts";
import { adminToken, garageTarget } from "./garage-target";
import { recordLayout } from "./layout";

type Secret = {
  name: "admin token" | "metrics token" | "session id";
  value: string;
};

type Surface = {
  place: string;
  text: string;
};

type Stores = {
  localStorage: string;
  sessionStorage: string;
  indexedDB: string;
  documentCookie: string;
};

type Jar = {
  text: string;
  sessionIds: string[];
};

test("checks storage and response bodies for the admin token and the session id", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const target = garageTarget();
  const admin = adminToken(target.container);
  expect(admin.length >= 16, "admin token missing").toBe(true);
  const metrics = metricsToken(target.container);
  const secrets: Secret[] = [{ name: "admin token", value: admin }];
  if (metrics !== null) {
    expect(metrics.length >= 16, "metrics token missing").toBe(true);
    secrets.push({ name: "metrics token", value: metrics });
  }

  const planted = leakMessages(
    [{ name: "session id", value: "e2e-planted-session-id" }],
    [{ place: "localStorage", text: "e2e-planted-session-id" }],
  );
  expect(planted.join(";") === "session id in localStorage", "leak scanner missed a planted value").toBe(
    true,
  );

  const bodies: string[] = [];
  const unreadable: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    pending.push(captureBody(response, bodies, unreadable));
  });

  await logIn(page);
  await installProbes(page);
  const loggedInJar = await cookieJar(page);
  expect(loggedInJar.sessionIds.length > 0, "session id missing from cookie jar").toBe(true);

  const secretSurfaces: Surface[] = [];
  const sessionSurfaces: Surface[] = [];
  expectReadable(await collectStores(page, "after login", secretSurfaces, sessionSurfaces), "after login");
  secretSurfaces.push({ place: "cookie jar after login", text: loggedInJar.text });
  await recordLayout(page, "token-storage-overview");

  await openSection(page, "Buckets", "Buckets");
  await collectStores(page, "after buckets", secretSurfaces, sessionSurfaces);
  await openSection(page, "Keys", "Keys");
  await collectStores(page, "after keys", secretSurfaces, sessionSurfaces);
  await openSection(page, "Settings", "About");
  await collectStores(page, "after settings", secretSurfaces, sessionSurfaces);
  await recordLayout(page, "token-storage-about");

  await page.setViewportSize({ width: 1280, height: 800 });
  await sections(page).getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cluster health" })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await settle(pending);
  expectReadable(
    await collectStores(page, "after logout", secretSurfaces, sessionSurfaces),
    "after logout",
  );
  const loggedOutJar = await cookieJar(page);
  secretSurfaces.push({ place: "cookie jar after logout", text: loggedOutJar.text });
  await settle(pending);

  for (const body of bodies) {
    secretSurfaces.push({ place: "response body", text: body });
    sessionSurfaces.push({ place: "response body", text: body });
  }

  expect(unreadable.length === 0, `response body unreadable ${unreadable.join(", ")}`).toBe(true);
  expect(
    bodies.some((body) => body.includes('"username":"ada"')),
    "login response body missing",
  ).toBe(true);
  expect(
    secretSurfaces.some((surface) => surface.place === "document.cookie after login" && surface.text.includes("garage_csrf=")),
    "csrf cookie missing from document.cookie",
  ).toBe(true);

  const hits = [
    ...leakMessages(secrets, secretSurfaces),
    ...leakMessages(
      loggedInJar.sessionIds.map((value) => ({ name: "session id" as const, value })),
      sessionSurfaces,
    ),
  ];
  expect(hits.length === 0, hits.join("; ")).toBe(true);
});

function leakMessages(secrets: Secret[], surfaces: Surface[]): string[] {
  const hits = new Set<string>();
  for (const secret of secrets) {
    if (secret.value.length < 16) {
      throw new Error(`${secret.name} missing`);
    }
    for (const surface of surfaces) {
      if (surface.text.includes(secret.value)) {
        hits.add(`${secret.name} in ${surface.place}`);
      }
    }
  }
  return [...hits];
}

async function logIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(administrator.username);
  await page.getByLabel("Password").fill(administrator.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cluster health" })).toBeVisible();
  await expect(page.getByText("Known nodes", { exact: true })).toBeVisible();
}

async function openSection(page: Page, link: string, heading: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await sections(page).getByRole("link", { name: link, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

function sections(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

async function collectStores(
  page: Page,
  when: string,
  secretSurfaces: Surface[],
  sessionSurfaces: Surface[],
): Promise<Stores> {
  const stores = await browserStores(page);
  const rows: Surface[] = [
    { place: `localStorage ${when}`, text: stores.localStorage },
    { place: `sessionStorage ${when}`, text: stores.sessionStorage },
    { place: `IndexedDB ${when}`, text: stores.indexedDB },
    { place: `document.cookie ${when}`, text: stores.documentCookie },
  ];
  secretSurfaces.push(...rows);
  sessionSurfaces.push(...rows);
  return stores;
}

function expectReadable(stores: Stores, when: string): void {
  expect(stores.localStorage.includes("e2e-storage-probe=present"), `localStorage unread ${when}`).toBe(
    true,
  );
  expect(
    stores.sessionStorage.includes("e2e-storage-probe=present"),
    `sessionStorage unread ${when}`,
  ).toBe(true);
  expect(stores.indexedDB.includes("e2e-storage-probe"), `IndexedDB unread ${when}`).toBe(true);
  expect(stores.documentCookie.includes("e2e_probe=present"), `document.cookie unread ${when}`).toBe(
    true,
  );
}

async function installProbes(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem("e2e-storage-probe", "present");
    sessionStorage.setItem("e2e-storage-probe", "present");
    document.cookie = "e2e_probe=present";
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("e2e-storage-probe", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("probe");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = opened.transaction("probe", "readwrite");
      tx.objectStore("probe").put("present", "e2e-storage-probe");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
    });
    opened.close();
  });
}

async function browserStores(page: Page): Promise<Stores> {
  return page.evaluate(async () => {
    const dumpStorage = (storage: Storage): string => {
      const parts: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) {
          continue;
        }
        parts.push(`${key}=${storage.getItem(key) ?? ""}`);
      }
      return parts.join("\n");
    };

    const done = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB read failed"));
      });

    const listed = await indexedDB.databases();
    const chunks: string[] = [];
    for (const info of listed) {
      if (!info.name) {
        continue;
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name as string);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
      });
      try {
        chunks.push(info.name);
        for (const storeName of Array.from(db.objectStoreNames)) {
          chunks.push(storeName);
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          chunks.push(Array.from(store.indexNames).join("\n"));
          chunks.push(JSON.stringify(await done(store.getAllKeys())));
          chunks.push(JSON.stringify(await done(store.getAll())));
        }
      } finally {
        db.close();
      }
    }

    return {
      localStorage: dumpStorage(localStorage),
      sessionStorage: dumpStorage(sessionStorage),
      indexedDB: chunks.join("\n"),
      documentCookie: document.cookie,
    };
  });
}

async function cookieJar(page: Page): Promise<Jar> {
  const cookies = await page.context().cookies();
  return {
    text: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n"),
    sessionIds: cookies
      .filter((cookie) => cookie.name === "garage_session" && cookie.value.length >= 16)
      .map((cookie) => cookie.value),
  };
}

function captureBody(response: Response, bodies: string[], unreadable: string[]): Promise<void> {
  const status = response.status();
  let path = "";
  try {
    path = new URL(response.url()).pathname;
  } catch {
    path = "";
  }
  return response.body().then(
    (raw) => {
      bodies.push(Buffer.from(raw).toString("latin1"));
    },
    () => {
      if (status === 204 || status === 205) {
        bodies.push("");
        return;
      }
      if (status !== 0 && (status < 300 || status >= 400)) {
        unreadable.push(`${status} ${path}`);
      }
    },
  );
}

async function settle(pending: Promise<void>[]): Promise<void> {
  let rounds = 0;
  while (pending.length > 0) {
    rounds += 1;
    if (rounds > 30) {
      throw new Error("response bodies did not settle");
    }
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

function metricsToken(container: string): string | null {
  return fieldValue(garageConfig(container), "metrics_token");
}

function garageConfig(container: string): string {
  const configPath = configFile(container);
  const dir = mkdtempSync(join(tmpdir(), "garage-ui-e2e-metrics-"));
  const file = join(dir, "garage.toml");
  try {
    execFileSync("docker", ["cp", `${container}:${configPath}`, file], { stdio: "pipe" });
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configFile(container: string): string {
  const raw = execFileSync(
    "docker",
    ["inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
    { encoding: "utf8" },
  );
  const line = raw.split("\n").find((row) => row.startsWith("GARAGE_CONFIG_FILE="));
  if (!line) {
    throw new Error(`${container} has no GARAGE_CONFIG_FILE`);
  }
  const path = line.slice("GARAGE_CONFIG_FILE=".length).trim();
  if (!path.startsWith("/")) {
    throw new Error(`${container} GARAGE_CONFIG_FILE is not absolute`);
  }
  return path;
}

function fieldValue(text: string, field: string): string | null {
  const line = text
    .split("\n")
    .map((row) => row.trim())
    .find((row) => fieldLine(row, field));
  if (!line) {
    return null;
  }
  const equals = line.indexOf("=");
  if (equals < 0) {
    throw new Error(`${field} field has no value`);
  }
  let value = line.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function fieldLine(row: string, field: string): boolean {
  if (!row.startsWith(field)) {
    return false;
  }
  const next = row.charAt(field.length);
  return next === "=" || next === " " || next === "\t";
}
