import { useQuery } from "@tanstack/react-query";
import { isGarageDown } from "./garageDown";

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
    throw new Error("Capabilities are unavailable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Capabilities are unavailable");
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
    throw new Error("Capabilities are unavailable");
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

// api() 只保留 message。关于区块还要显示响应里的 code，所以在这里读正文。
async function loadCapabilities(): Promise<Capabilities> {
  const response = await fetch("/api/capabilities", { credentials: "include" });
  const text = await response.text();
  if (!response.ok) {
    throw new CapabilitiesError(failureFrom(text, response.status));
  }
  return parseCapabilities(text);
}

function garageLine(version: string | null | undefined): string {
  if (typeof version !== "string") {
    return "Garage version is not set";
  }
  return `Garage ${version}`;
}

export function About({ garageVersion }: { garageVersion: string | null | undefined }) {
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: loadCapabilities,
  });
  const failure = capabilities.error ? failureOf(capabilities.error) : null;
  return (
    <section className="grid gap-4" aria-label="About">
      <h2 className="text-lg font-semibold">About</h2>
      <p>{garageLine(garageVersion)}</p>
      {failure && !isGarageDown(failure) ? (
        <>
          <p>
            {failure.message}
            {failure.code ? ` ${failure.code}` : ""}
          </p>
          <button
            className="border border-ink px-3 py-1 text-left"
            type="button"
            onClick={() => {
              void capabilities.refetch();
            }}
          >
            Retry
          </button>
        </>
      ) : null}
      {!failure && capabilities.data ? (
        <>
          <p>Version {capabilities.data.version}</p>
          <p>List buckets info {capabilities.data.listBucketsInfo}</p>
          <p>List keys info {capabilities.data.listKeysInfo}</p>
        </>
      ) : null}
    </section>
  );
}
