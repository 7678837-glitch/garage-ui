import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api/client";

type AccessKey = {
  id: string;
  name: string | null;
};

type KeyPage = {
  items: AccessKey[];
  hasMore: boolean;
};

// 服务端未传 limit 时窗口是 100。下一页 offset 用本页条数。
const PAGE_LIMIT = 100;

function parseKey(value: unknown): AccessKey {
  if (typeof value !== "object" || value === null) {
    throw new Error("Keys are unavailable");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new Error("Keys are unavailable");
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
  };
}

function parsePage(body: unknown): KeyPage {
  if (typeof body !== "object" || body === null) {
    throw new Error("Keys are unavailable");
  }
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new Error("Keys are unavailable");
  }
  return {
    items: page.items.map(parseKey),
    hasMore: page.hasMore,
  };
}

function nextOffset(offset: number, page: KeyPage): number | undefined {
  if (!page.hasMore || page.items.length === 0) {
    return undefined;
  }
  return offset + page.items.length;
}

async function loadPage(offset: number): Promise<KeyPage> {
  const body = await api<unknown>(`/api/keys?offset=${offset}&limit=${PAGE_LIMIT}`);
  return parsePage(body);
}

export function Keys() {
  const list = useInfiniteQuery({
    queryKey: ["keys"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => loadPage(pageParam),
    getNextPageParam: (page, _pages, offset) => nextOffset(offset, page),
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const message = list.error instanceof Error ? list.error.message : "Keys are unavailable";

  return (
    <section className="grid gap-4" aria-label="Keys">
      <h2 className="text-lg font-semibold">Keys</h2>
      {list.isPending ? <p>Loading keys</p> : null}
      {list.isError ? <p>{message}</p> : null}
      {list.data ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">
                  Key
                </th>
                <th className="py-2 font-medium" scope="col">
                  Name
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((accessKey, index) => (
                <tr key={`${accessKey.id}-${index}`}>
                  <td className="py-2 pr-3">{accessKey.id}</td>
                  <td className="py-2">{accessKey.name}</td>
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
