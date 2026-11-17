import { afterEach, describe, expect, it } from "bun:test";
import { createNocoDbClient } from "./createNocoDbClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const params = {
  baseUrl: "http://93.184.216.34/custom",
  baseId: "base-id",
  tableId: "table-id",
  apiKey: "test-api-key",
};

describe("NocoDB v3 migration", () => {
  it("requires a base ID before making requests", () => {
    expect(() =>
      createNocoDbClient({ ...params, baseId: undefined }),
    ).toThrow("Base ID is required");
  });

  it("retains host overrides, pagination, primary fields and hidden view fields", async () => {
    const requestedUrls: URL[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      requestedUrls.push(url);
      expect(new Headers(init?.headers).get("xc-token")).toBe("test-api-key");
      expect(url.origin).toBe("http://93.184.216.34");
      expect(url.pathname.startsWith("/custom/api/v3/")).toBe(true);
      if (url.pathname.includes("/meta/"))
        return Response.json({ fields: [] });
      if (url.pathname.endsWith("/count")) {
        expect(url.searchParams.get("where")).toBe("(Name,eq,Alice)");
        expect(url.searchParams.get("viewId")).toBe("view-id");
        return Response.json({ count: 7 });
      }
      if (url.pathname.endsWith("/records")) {
        expect(url.searchParams.get("viewId")).toBe("view-id");
        const offset = Number(url.searchParams.get("offset"));
        return Response.json({
          records:
            offset === 0
              ? [{ id: "a", fields: {} }, { id: "b", fields: {} }]
              : [{ id: "c", fields: {} }],
          next: "https://example.invalid/untrusted-pagination",
        });
      }
      expect(url.search).toBe("");
      const id = url.pathname.split("/").pop();
      return Response.json({
        id,
        id_fields: { PrimaryKey: id },
        fields: { Hidden: `hidden-${id}` },
      });
    });

    const response = await createNocoDbClient(params).listRecords({
      limit: "3",
      where: "(Name,eq,Alice)",
      viewId: "view-id",
    });

    expect(response.list).toEqual([
      { Id: "a", PrimaryKey: "a", Hidden: "hidden-a" },
      { Id: "b", PrimaryKey: "b", Hidden: "hidden-b" },
      { Id: "c", PrimaryKey: "c", Hidden: "hidden-c" },
    ]);
    expect(response.pageInfo.totalRows).toBe(7);
    expect(
      requestedUrls
        .filter((url) => url.pathname.endsWith("/records"))
        .map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")]),
    ).toEqual([["0", "3"], ["2", "1"]]);
  });

  it("wraps writes, strips replacement link writes, and batches updates", async () => {
    const writes: { method: string; body: unknown }[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      if (url.pathname.includes("/meta/"))
        return Response.json({
          fields: [{ id: "relation-id", title: "Related", type: "Links" }],
        });
      writes.push({
        method: init?.method ?? "GET",
        body: await new Response(init?.body).json(),
      });
      if (init?.method === "POST")
        return Response.json({ records: [{ id: "created-id", fields: {} }] });
      return Response.json({ records: [] });
    });

    const client = createNocoDbClient(params);
    expect(await client.createRecord({ Name: "Alice", Related: "42" })).toEqual({
      Id: "created-id",
    });
    await client.updateRecords(
      Array.from({ length: 11 }, (_, index) => ({
        Id: `record-${index}`,
        Name: null,
        Related: "42",
      })),
    );

    expect(writes[0]).toEqual({
      method: "POST",
      body: { fields: { Name: "Alice" } },
    });
    expect(writes.slice(1)).toEqual([
      {
        method: "PATCH",
        body: Array.from({ length: 10 }, (_, index) => ({
          id: `record-${index}`,
          fields: { Name: null },
        })),
      },
      {
        method: "PATCH",
        body: [{ id: "record-10", fields: { Name: null } }],
      },
    ]);
  });
});

const replaceFetch = (
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
) => {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
};

const getRequestUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
