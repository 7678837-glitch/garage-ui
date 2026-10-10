export type AuthStatus = {
  initialized: boolean;
  authenticated: boolean;
  username: string | null;
  role: string | null;
  can_download: boolean | null;
  can_share: boolean | null;
};

const CSRF_EXEMPT = new Set(["/api/setup", "/api/auth/login"]);

function csrfToken(): string {
  const found = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("garage_csrf="));
  if (!found) {
    return "";
  }
  return decodeURIComponent(found.slice("garage_csrf=".length));
}

function messageFrom(text: string, status: number): string {
  const fallback = `request failed (${status})`;
  if (!text.startsWith("{")) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
  if (typeof parsed === "object" && parsed && "message" in parsed) {
    const message = parsed.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !CSRF_EXEMPT.has(path)) {
    headers.set("x-csrf-token", csrfToken());
  }
  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "include",
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(messageFrom(text, response.status));
  }
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}
