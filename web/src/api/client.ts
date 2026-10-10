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

export class ApiError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function failureFrom(text: string, status: number): { message: string; code: string | null } {
  const fallback = `request failed (${status})`;
  if (!text.startsWith("{")) {
    return { message: fallback, code: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { message: fallback, code: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { message: fallback, code: null };
  }
  const body = parsed as Record<string, unknown>;
  const message =
    typeof body.message === "string" && body.message.length > 0 ? body.message : fallback;
  const code = typeof body.code === "string" && body.code.length > 0 ? body.code : null;
  return { message, code };
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
    const failure = failureFrom(text, response.status);
    throw new ApiError(failure.message, failure.code);
  }
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}
