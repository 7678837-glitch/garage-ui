import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { api } from "./api/client";

type Bucket = {
  id: string;
  aliases: string[];
};

type BucketPage = {
  items: Bucket[];
  hasMore: boolean;
};

// 服务端未传 limit 时窗口是 100。下一页 offset 用本页条数。
const PAGE_LIMIT = 100;

function aliasName(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || !("alias" in value)) {
    return null;
  }
  return typeof value.alias === "string" ? value.alias : null;
}

function aliasNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = aliasName(entry);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

function parseBucket(value: unknown): Bucket {
  if (typeof value !== "object" || value === null) {
    throw new Error("Buckets are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error("Buckets are unavailable");
  }
  return {
    id: row.id,
    aliases: [...aliasNames(row.globalAliases), ...aliasNames(row.localAliases)],
  };
}

function parsePage(body: unknown): BucketPage {
  if (typeof body !== "object" || body === null) {
    throw new Error("Buckets are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Buckets are unavailable");
  }
  return {
    items: page.items.map(parseBucket),
    hasMore: page.hasMore,
  };
}

function nextOffset(offset: number, page: BucketPage): number | undefined {
  if (!page.hasMore || page.items.length === 0) {
    return undefined;
  }
  return offset + page.items.length;
}

async function loadPage(offset: number): Promise<BucketPage> {
  const body = await api<unknown>(`/api/buckets?offset=${offset}&limit=${PAGE_LIMIT}`);
  return parsePage(body);
}

export function Buckets() {
  const list = useInfiniteQuery({
    queryKey: ["buckets"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => loadPage(pageParam),
    getNextPageParam: (page, _pages, offset) => nextOffset(offset, page),
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const message = list.error instanceof Error ? list.error.message : "Buckets are unavailable";

  return (
    <section className="grid gap-4" aria-label="Buckets">
      <h2 className="text-lg font-semibold">Buckets</h2>
      {list.isPending ? <p>Loading buckets</p> : null}
      {list.isError ? <p>{message}</p> : null}
      {list.data ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Bucket
                </th>
                <th className="py-2 font-medium" scope="col">
                  Aliases
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bucket, index) => (
                <tr key={`${bucket.id}-${index}`}>
                  <td className="py-2 pr-3">{bucket.id}</td>
                  <td className="py-2">
                    {bucket.aliases.map((alias, aliasIndex) => (
                      <Fragment key={`${bucket.id}-${aliasIndex}`}>
                        {aliasIndex > 0 ? ", " : null}
                        <span>{alias}</span>
                      </Fragment>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <button
          className="border border-neutral-900 px-3 py-1 text-left"
          type="button"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          Load more
        </button>
      ) : null}
    </section>
  );
}
