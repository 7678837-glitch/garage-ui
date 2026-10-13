import { administrator, readOnlyUser } from "./accounts";

const base = "http://127.0.0.1:3909";

export default async function globalSetup(): Promise<void> {
  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: administrator.username,
      password: administrator.password,
    }),
  });
  if (setup.status !== 200) {
    throw new Error(`setup failed with status ${setup.status}`);
  }
  const session = cookieValue(setup, "garage_session");
  const csrf = cookieValue(setup, "garage_csrf");
  const created = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `garage_session=${session}; garage_csrf=${csrf}`,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify({
      username: readOnlyUser.username,
      password: readOnlyUser.password,
      role: "viewer",
    }),
  });
  if (created.status !== 201) {
    throw new Error(`read-only user create failed with status ${created.status}`);
  }
}

function cookieValue(response: Response, name: string): string {
  const lines =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(";")[0] ?? "";
    const prefix = `${name}=`;
    if (pair.startsWith(prefix)) {
      return decodeURIComponent(pair.slice(prefix.length));
    }
  }
  throw new Error(`setup response missing ${name} cookie`);
}
