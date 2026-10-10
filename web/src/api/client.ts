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

// 与 App.encodeObjectKey 同一套非保留字符。encodeURIComponent 会留下 !'()*，对象路径对不上。
const UNRESERVED = /[A-Za-z0-9._~-]/;

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(segment)) {
    const character = String.fromCharCode(byte);
    if (UNRESERVED.test(character)) {
      out += character;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function putObject(input: {
  bucketId: string;
  key: string;
  body: Blob;
  contentType: string;
  onProgress: (percent: number | null) => void;
}): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  xhr.open(
    "PUT",
    `/api/buckets/${encodeURIComponent(input.bucketId)}/objects/${encodeKey(input.key)}`,
  );
  xhr.withCredentials = true;
  xhr.setRequestHeader("content-type", input.contentType);
  xhr.setRequestHeader("x-csrf-token", csrfToken());
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable || event.total <= 0) {
      input.onProgress(null);
      return;
    }
    input.onProgress(Math.floor((event.loaded / event.total) * 100));
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
      reject(new Error(`request failed (${xhr.status})`));
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
