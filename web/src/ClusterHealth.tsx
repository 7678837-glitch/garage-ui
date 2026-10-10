import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";

const COUNTS = [
  ["knownNodes", "Known nodes"],
  ["connectedNodes", "Connected nodes"],
  ["storageNodes", "Storage nodes"],
  ["storageNodesUp", "Storage nodes up"],
  ["partitions", "Partitions"],
  ["partitionsQuorum", "Partitions with quorum"],
  ["partitionsAllOk", "Partitions all ok"],
] as const;

type CountKey = (typeof COUNTS)[number][0];

type ClusterHealthReport = {
  status: string;
  knownNodes: number;
  connectedNodes: number;
  storageNodes: number;
  storageNodesUp: number;
  partitions: number;
  partitionsQuorum: number;
  partitionsAllOk: number;
};

function countOf(row: Record<string, unknown>, key: CountKey): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Cluster health is unavailable");
  }
  return value;
}

function parseHealth(body: unknown): ClusterHealthReport {
  if (typeof body !== "object" || body === null) {
    throw new Error("Cluster health is unavailable");
  }
  const row = body as Record<string, unknown>;
  if (typeof row.status !== "string" || row.status.length === 0) {
    throw new Error("Cluster health is unavailable");
  }
  return {
    status: row.status,
    knownNodes: countOf(row, "knownNodes"),
    connectedNodes: countOf(row, "connectedNodes"),
    storageNodes: countOf(row, "storageNodes"),
    storageNodesUp: countOf(row, "storageNodesUp"),
    partitions: countOf(row, "partitions"),
    partitionsQuorum: countOf(row, "partitionsQuorum"),
    partitionsAllOk: countOf(row, "partitionsAllOk"),
  };
}

export function ClusterHealth() {
  const health = useQuery({
    queryKey: ["cluster", "health"],
    queryFn: async () => parseHealth(await api<unknown>("/api/cluster/health")),
  });
  const message =
    health.error instanceof Error ? health.error.message : "Cluster health is unavailable";

  return (
    <section className="grid gap-4" aria-label="Cluster health">
      <h2 className="text-lg font-semibold">Cluster health</h2>
      {health.isPending ? <p>Loading cluster health</p> : null}
      {health.isError ? <p>{message}</p> : null}
      {health.isSuccess ? (
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="font-medium">Status</dt>
            <dd>{health.data.status}</dd>
          </div>
          {COUNTS.map(([key, label]) => (
            <div key={key}>
              <dt className="font-medium">{label}</dt>
              <dd>{health.data[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
