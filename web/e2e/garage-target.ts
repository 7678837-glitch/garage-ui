import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GarageTarget = {
  version: string;
  container: string;
  adminUrl: string;
  s3Url: string;
};

const targets: Record<string, GarageTarget> = {
  "v2.4.1": {
    version: "v2.4.1",
    container: "garage-wave1-v241",
    adminUrl: "http://127.0.0.1:3953",
    s3Url: "http://127.0.0.1:3950",
  },
  "v2.3.0": {
    version: "v2.3.0",
    container: "garage-wave1-v230",
    adminUrl: "http://127.0.0.1:3943",
    s3Url: "http://127.0.0.1:3940",
  },
};

export function garageTarget(): GarageTarget {
  const version = process.env.GARAGE_VERSION ?? "v2.4.1";
  const target = targets[version];
  if (!target) {
    throw new Error("GARAGE_VERSION must be v2.4.1 or v2.3.0");
  }
  return target;
}

export function adminToken(container: string): string {
  const configPath = configFile(container);
  const dir = mkdtempSync(join(tmpdir(), "garage-ui-e2e-"));
  const file = join(dir, "garage.toml");
  try {
    execFileSync("docker", ["cp", `${container}:${configPath}`, file], { stdio: "pipe" });
    return tokenFrom(readFileSync(file, "utf8"));
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

function tokenFrom(text: string): string {
  const line = text
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.startsWith("admin_token"));
  if (!line) {
    throw new Error("garage config has no admin_token field");
  }
  const equals = line.indexOf("=");
  if (equals < 0) {
    throw new Error("garage admin_token field has no value");
  }
  let value = line.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value.length < 16) {
    throw new Error("garage admin_token field is too short");
  }
  return value;
}
