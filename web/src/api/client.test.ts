import { afterEach, expect, test, vi } from "vitest";
import { advanceAuthGeneration, api, bindUnauthenticated, captureAuthGeneration, noteUnauthenticated, putObject } from "./client";

afterEach(() => {
  bindUnauthenticated(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("only an unauthenticated 401 from the current session clears authentication", () => {
  const clear = vi.fn();
  bindUnauthenticated(clear);
  const generation = captureAuthGeneration();
  noteUnauthenticated(403, "unauthenticated", generation);
  noteUnauthenticated(401, "invalid_credentials", generation);
  expect(clear).not.toHaveBeenCalled();
  noteUnauthenticated(401, "unauthenticated", generation);
  expect(clear).toHaveBeenCalledOnce();
  noteUnauthenticated(401, "unauthenticated", generation);
  expect(clear).toHaveBeenCalledOnce();
  noteUnauthenticated(401, "unauthenticated", captureAuthGeneration());
  expect(clear).toHaveBeenCalledTimes(2);
});

test("a delayed API error still rejects without clearing a replacement session", async () => {
  let finishBody!: (text: string) => void;
  const body = new Promise<string>((resolve) => { finishBody = resolve; });
  const response = new Response(null, { status: 401 });
  vi.spyOn(response, "text").mockImplementation(() => body);
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const clear = vi.fn();
  bindUnauthenticated(clear);
  const result = api("/api/keys").catch((error: unknown) => error);
  advanceAuthGeneration();
  finishBody(JSON.stringify({ code: "unauthenticated", message: "Login required" }));
  expect(await result).toMatchObject({ code: "unauthenticated", message: "Login required" });
  expect(clear).not.toHaveBeenCalled();
});

test("uploads capture their session before send and ignore an older session's 401", async () => {
  const requests: UploadRequest[] = [];
  class UploadRequest {
    status = 401;
    responseText = JSON.stringify({ code: "unauthenticated", message: "Login required" });
    withCredentials = false;
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() { requests.push(this); }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  const clear = vi.fn();
  bindUnauthenticated(clear);
  const input = { bucketId: "bucket-a", key: "file.txt", body: new Blob(["body"]), contentType: "text/plain", onProgress: vi.fn() };
  const old = putObject(input).promise.catch((error: unknown) => error);
  advanceAuthGeneration();
  requests[0].onload?.();
  expect(await old).toBeInstanceOf(Error);
  expect(clear).not.toHaveBeenCalled();
  const current = putObject(input).promise.catch((error: unknown) => error);
  requests[1].onload?.();
  expect(await current).toBeInstanceOf(Error);
  expect(clear).toHaveBeenCalledOnce();
});
