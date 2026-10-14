import type { APIRequestContext, APIResponse, Page, Response } from "@playwright/test";

const maxLoginAttempts = 3;
const maxRetryAfterSeconds = 60;

async function retryLogin<T extends Response | APIResponse>(submit: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await submit();
    if (response.status() !== 429) return response;
    if (attempt === maxLoginAttempts) {
      throw new Error(`Login failed with status 429 after ${maxLoginAttempts} submissions`);
    }
    const header = response.headers()["retry-after"];
    const seconds = Number(header);
    if (!header || !/^\d+$/.test(header) || !Number.isFinite(seconds) || seconds < 0 || seconds > maxRetryAfterSeconds) {
      throw new Error("Login failed with status 429 and an invalid Retry-After header");
    }
    // The server floors its remaining duration to seconds, so allow the unfinished second.
    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000 + 1000));
  }
}

export async function submitLogin(page: Page): Promise<Response> {
  return retryLogin(async () => {
    const [response] = await Promise.all([
      page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === "/api/auth/login"),
      page.getByRole("button", { name: "Log in", exact: true }).click(),
    ]);
    return response;
  });
}

export async function requestLogin(request: APIRequestContext, credentials: { username: string; password: string }): Promise<APIResponse> {
  return retryLogin(() => request.post("/api/auth/login", { data: credentials }));
}
