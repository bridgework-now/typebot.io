import { afterEach, expect, it } from "bun:test";
import { createNocoDbClient } from "./createNocoDbClient";
import { linkRelationUpdatesIfAny } from "./linkRelationUpdatesIfAny";
import { resolveNocoDbBaseId } from "./resolveNocoDbBaseId";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("preserves filters, counts and flat mappings across capped v3 pages", async () => {
  const requests = mockResponses([
    { count: 9 },
    {
      records: [{ id: "row-a", fields: { Name: "Alice" } }],
      next: "http://127.0.0.1/untrusted-next",
    },
    {
      records: [
        { id: "row-b", id_fields: { Key: "row-b" }, fields: { Name: "Bob" } },
        { id: "row-c", fields: { Name: "Carol" } },
      ],
      next: null,
    },
  ]);
  const response = await client().listRecords({
    where: "(Name,neq,Excluded)",
    viewId: "view-id",
    limit: 2,
  });

  expect(response.list).toEqual([
    { Id: "row-a", Name: "Alice" },
    { Id: "row-b", Key: "row-b", Name: "Bob" },
  ]);
  expect(response.pageInfo.totalRows).toBe(9);
  expect(requests.map(({ url }) => url.origin)).toEqual([
    host,
    host,
    host,
  ]);
  expect(requests.map(({ url }) => url.searchParams.get("page"))).toEqual([
    null,
    "1",
    "2",
  ]);
  for (const { url, headers } of requests) {
    expect(url.searchParams.get("where")).toBe("(Name,neq,Excluded)");
    expect(url.searchParams.get("viewId")).toBe("view-id");
    expect(headers.get("xc-token")).toBe("test-token");
  }
  expect(requests[1]?.url.searchParams.get("pageSize")).toBe("2");
  expect(requests[1]?.url.searchParams.get("linksAsLtar")).toBe("true");
});

it("uses the cloud default and excludes additive links from create fields", async () => {
  const requests = mockResponses([
    table,
    { records: [{ id: "new-row", fields: { Name: "Alice" } }] },
  ]);
  const response = await createNocoDbClient({
    baseUrl: undefined,
    baseId: "base-id",
    apiKey: "test-token",
    tableId: "table-id",
  }).createRecord({ Name: "Alice", Related: "42" });

  expect(response).toEqual({ Id: "new-row" });
  expect(requests.map(({ url }) => url.origin)).toEqual([
    "https://app.nocodb.com",
    "https://app.nocodb.com",
  ]);
  expect(requests[1]?.method).toBe("POST");
  expect(requests[1]?.body).toEqual({ fields: { Name: "Alice" } });
});

it("writes each selected id with nulls intact and keeps links out of PATCH", async () => {
  const requests = mockResponses([table, undefined, undefined]);
  await client().updateRecords([
    { Id: "row-a", Name: null, Related: "42" },
    { Id: 2, Name: "", Related: "43" },
    { Id: 3, Related: "44" },
  ]);

  expect(requests.slice(1).map(({ method, body }) => ({ method, body }))).toEqual([
    { method: "PATCH", body: { id: "row-a", fields: { Name: null } } },
    { method: "PATCH", body: { id: 2, fields: { Name: "" } } },
  ]);
});

it("maps v3 relation metadata and sends lowercase ids to additive links", async () => {
  const requests = mockResponses([table, { success: true }]);
  await linkRelationUpdatesIfAny({
    baseUrl: host,
    baseId: "base-id",
    apiKey: "test-token",
    tableId: "table-id",
    updates: [{ fieldName: "Related", value: '["42","43"]' }],
    recordIdsToUpdate: ["row-a"],
  });

  expect(requests.map(({ url }) => url.pathname)).toEqual([
    "/api/v3/meta/bases/base-id/tables/table-id",
    "/api/v3/data/base-id/table-id/links/relation-id/row-a",
  ]);
  expect(requests[1]?.body).toEqual([{ id: "42" }, { id: "43" }]);
});

it("rejects a missing create response id instead of linking undefined", async () => {
  mockResponses([table, { records: [] }]);
  await expect(client().createRecord({ Name: "Alice" })).rejects.toThrow(
    "NocoDB did not return the created record",
  );
});

it("keeps an explicit Base ID without making a discovery request", async () => {
  const requests = mockResponses([]);
  expect(
    await resolveNocoDbBaseId({
      baseUrl: host,
      baseId: "configured-base",
      apiKey: "test-token",
      tableId: "table-id",
    }),
  ).toBe("configured-base");
  expect(requests).toEqual([]);
});

it("resolves saved actions on the configured host or cloud default", async () => {
  for (const baseUrl of [host, undefined]) {
    const requests = mockResponses([{ base_id: "resolved-base" }]);
    expect(
      await resolveNocoDbBaseId({
        baseUrl,
        baseId: undefined,
        apiKey: "test-token",
        tableId: "table/id",
      }),
    ).toBe("resolved-base");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.origin).toBe(baseUrl ?? "https://app.nocodb.com");
    expect(requests[0]?.url.pathname).toBe("/api/v2/meta/tables/table%2Fid");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("xc-token")).toBe("test-token");
  }
});

it("rejects absent or invalid discovery IDs before any record request", async () => {
  for (const base_id of [undefined, "", 42]) {
    const requests = mockResponses([{ base_id }]);
    await expect(
      resolveNocoDbBaseId({
        baseUrl: host,
        baseId: "",
        apiKey: "test-token",
        tableId: "table-id",
      }),
    ).rejects.toThrow("Could not resolve NocoDB Base ID");
    expect(requests).toHaveLength(1);
  }
});

const host = "http://93.184.216.34";
const table = {
  fields: [
    { id: "name-id", title: "Name", type: "SingleLineText" },
    { id: "relation-id", title: "Related", type: "Links" },
  ],
};

const client = () =>
  createNocoDbClient({
    baseUrl: host,
    baseId: "base-id",
    apiKey: "test-token",
    tableId: "table-id",
  });

const mockResponses = (responses: unknown[]) => {
  const requests: {
    url: URL;
    method: string;
    headers: Headers;
    body: unknown;
  }[] = [];
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      const body = await request.text();
      requests.push({
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
        body: body ? JSON.parse(body) : undefined,
      });
      if (requests.length > responses.length)
        throw new Error("Unexpected NocoDB request");
      const response = responses[requests.length - 1];
      return response === undefined
        ? new Response(null, { status: 200 })
        : Response.json(response);
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
};
