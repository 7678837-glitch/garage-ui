import { useQuery } from "@tanstack/react-query";
import { noteUnauthenticated } from "./api/client";
import { isGarageDown } from "./garageDown";
import { copy, fill } from "./i18n";

type ProbeWord = "unknown" | "present" | "absent";

type Capabilities = {
  version: string;
  listBucketsInfo: ProbeWord;
  listKeysInfo: ProbeWord;
};

type CapabilitiesFailure = {
  message: string;
  code: string | null;
};

class CapabilitiesError extends Error {
  readonly code: string | null;

  constructor(failure: CapabilitiesFailure) {
    super(failure.message);
    this.name = "CapabilitiesError";
    this.code = failure.code;
  }
}

function probeWord(value: unknown): ProbeWord | null {
  if (value === "unknown" || value === "present" || value === "absent") {
    return value;
  }
  return null;
}

function failureFrom(text: string, status: number): CapabilitiesFailure {
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

function parseCapabilities(text: string): Capabilities {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(copy("ui.capabilities.are.unavailable"));
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(copy("ui.capabilities.are.unavailable"));
  }
  const body = parsed as Record<string, unknown>;
  const listBucketsInfo = probeWord(body.listBucketsInfo);
  const listKeysInfo = probeWord(body.listKeysInfo);
  if (
    typeof body.version !== "string" ||
    body.version.length === 0 ||
    listBucketsInfo === null ||
    listKeysInfo === null
  ) {
    throw new Error(copy("ui.capabilities.are.unavailable"));
  }
  return {
    version: body.version,
    listBucketsInfo,
    listKeysInfo,
  };
}

function failureOf(error: Error): CapabilitiesFailure {
  if (error instanceof CapabilitiesError) {
    return { message: error.message, code: error.code };
  }
  return { message: error.message, code: null };
}

// api() keeps only message. About also shows the response code, so read the body here.
async function loadCapabilities(): Promise<Capabilities> {
  const response = await fetch("/api/capabilities", { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    const failure = failureFrom(text, response.status);
    noteUnauthenticated(response.status, failure.code);
    throw new CapabilitiesError(failure);
  }
  return parseCapabilities(text);
}

export function garageLine(version: string | null | undefined): string {
  if (typeof version !== "string") {
    return copy("ui.garage.version.is.not.set");
  }
  return fill(copy("ui.garage"), { version: version });
}

export function About({ garageVersion }: { garageVersion: string | null | undefined }) {
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: loadCapabilities,
  });
  const failure = capabilities.error ? failureOf(capabilities.error) : null;
  return (
    <section className="ui-panel" aria-label={copy("ui.about")}>
      <h2 className="text-lg font-semibold">{copy("ui.about")}</h2>
      <p>{garageLine(garageVersion)}</p>
      {failure && !isGarageDown(failure) ? (
        <>
          <p>
            {failure.message}
            {failure.code ? ` ${failure.code}` : ""}
          </p>
          <button
            className="ui-button"
            type="button"
            onClick={() => {
              void capabilities.refetch();
            }}
          >
            {copy("ui.retry")}</button>
        </>
      ) : null}
      {!failure && capabilities.data ? (
        <>
          <p>{fill(copy("ui.version.2"), { version: capabilities.data.version })}</p>
          <p>{fill(copy("ui.list.buckets.info"), { listBucketsInfo: capabilities.data.listBucketsInfo })}</p>
          <p>{fill(copy("ui.list.keys.info"), { listKeysInfo: capabilities.data.listKeysInfo })}</p>
        </>
      ) : null}
    </section>
  );
}
