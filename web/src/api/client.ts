import { copy, fill } from "../i18n";
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

type UnauthenticatedHook = (status: number, code: string | null) => void;

let unauthenticatedHook: UnauthenticatedHook | null = null;
let authGeneration = 0;

export function captureAuthGeneration(): number {
  return authGeneration;
}

export function advanceAuthGeneration(): void {
  authGeneration += 1;
}

export function bindUnauthenticated(hook: UnauthenticatedHook | null): void {
  unauthenticatedHook = hook;
}

export function noteUnauthenticated(status: number, code: string | null, requestGeneration: number): void {
  if (status !== 401 || code !== "unauthenticated" || requestGeneration !== authGeneration) {
    return;
  }
  advanceAuthGeneration();
  unauthenticatedHook?.(status, code);
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
  const requestGeneration = captureAuthGeneration();
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
    noteUnauthenticated(response.status, failure.code, requestGeneration);
    throw new ApiError(failure.message, failure.code);
  }
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

// The key goes in the query because browsers collapse `.` and `..` path segments, so a key like
// `dir/../x` would otherwise address `x`.
export function objectPath(bucketId: string, key: string, extra: Record<string, string> = {}): string {
  return `/api/buckets/${encodeURIComponent(bucketId)}/object?${new URLSearchParams({ key, ...extra }).toString()}`;
}

export function putObject(input: {
  bucketId: string;
  key: string;
  body: Blob;
  contentType: string;
  onProgress: (progress: { percent: number | null; loaded: number }) => void;
}): { promise: Promise<void>; abort: () => void } {
  const requestGeneration = captureAuthGeneration();
  const xhr = new XMLHttpRequest();
  let aborted = false;
  xhr.open("PUT", objectPath(input.bucketId, input.key));
  xhr.withCredentials = true;
  xhr.setRequestHeader("content-type", input.contentType);
  xhr.setRequestHeader("x-csrf-token", csrfToken());
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable || event.total <= 0) {
      input.onProgress({ percent: null, loaded: event.loaded });
      return;
    }
    input.onProgress({
      percent: Math.floor((event.loaded / event.total) * 100),
      loaded: event.loaded,
    });
  };
  const promise = new Promise<void>((resolve, reject) => {
    xhr.onload = () => {
      if (aborted) {
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      const failure = failureFrom(xhr.responseText, xhr.status);
      noteUnauthenticated(xhr.status, failure.code, requestGeneration);
      reject(new Error(fill(copy("ui.request.failed"), { status: xhr.status })));
    };
    xhr.onerror = () => {
      if (!aborted) {
        reject(new Error("request failed"));
      }
    };
    xhr.onabort = () => {
      aborted = true;
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
  });
  xhr.send(input.body);
  return {
    promise,
    abort() {
      aborted = true;
      xhr.abort();
    },
  };
}
