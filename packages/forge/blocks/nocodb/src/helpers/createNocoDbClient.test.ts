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
  it.each([
    { baseUrl: undefined, baseId: undefined, origin: "https://app.nocodb.com" },
    { baseUrl: params.baseUrl, baseId: "", origin: params.baseUrl },
  ])("preserves saved v2 credentials with $baseUrl", async ({ baseUrl, baseId, origin }) => {
    const requests: { url: URL; method: string; body: unknown }[] = [];
    const metadata = {
      columns: [{ id: "relation-id", title: "Related", uidt: "LinkToAnotherRecord" }],
    };
    const listed = {
      list: [{ Id: 7, Name: "Alice", Hidden: "retained" }],
      pageInfo: {
        totalRows: 12,
        page: 1,
        pageSize: 3,
        isFirstPage: true,
        isLastPage: false,
      },
    };
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      expect(new Headers(init?.headers).get("xc-token")).toBe(params.apiKey);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? await new Response(init.body).json() : undefined,
      });
      if (url.pathname.includes("/meta/")) return Response.json(metadata);
      if (init?.method === "GET") return Response.json(listed);
      if (init?.method === "PATCH") return new Response(null, { status: 200 });
      if (url.pathname.includes("/links/")) return Response.json(true);
      return Response.json({ Id: 7 });
    });

    const client = createNocoDbClient({ ...params, baseUrl, baseId });
    const fields = { Name: "Alice", Related: "42" };
    const updates = [{ Id: 7, Name: null, Related: "42" }];
    const searchParams = { where: "(Name,eq,Alice)", viewId: "view-id", limit: "3" };
    expect(await client.createRecord(fields)).toEqual({ Id: 7 });
    expect(await client.listRecords(searchParams)).toEqual(listed);
    await client.updateRecords(updates);
    expect(await client.getTableMetadata()).toEqual(metadata);
    await client.linkRecords("relation-id", 7, ["42"]);

    const recordsUrl = `${origin}/api/v2/tables/table-id/records`;
    expect(requests.map(({ url, method, body }) => ({
      url: `${url.origin}${url.pathname}`, method, body,
    }))).toEqual([
      { url: recordsUrl, method: "POST", body: fields },
      { url: recordsUrl, method: "GET", body: undefined },
      { url: recordsUrl, method: "PATCH", body: updates },
      { url: `${origin}/api/v2/meta/tables/table-id`, method: "GET", body: undefined },
      {
        url: `${origin}/api/v2/tables/table-id/links/relation-id/records/7`,
        method: "POST",
        body: [{ Id: "42" }],
      },
    ]);
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual(searchParams);
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
        expect(url.searchParams.has("limit")).toBe(false);
        expect(url.searchParams.has("offset")).toBe(false);
        const pageNumber = Number(url.searchParams.get("page"));
        return Response.json({
          records:
            pageNumber === 1
              ? [{ id: "a", fields: {} }, { id: "b", fields: {} }]
              : [{ id: "c", fields: {} }, { id: "d", fields: {} }],
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
        .map((url) => [url.searchParams.get("page"), url.searchParams.get("pageSize")]),
    ).toEqual([["1", "3"], ["2", "3"]]);
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
