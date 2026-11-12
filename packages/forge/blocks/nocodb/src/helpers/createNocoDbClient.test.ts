import { afterEach, expect, it } from "bun:test";
import { createNocoDbClient } from "./createNocoDbClient";
import { linkRelationUpdatesIfAny } from "./linkRelationUpdatesIfAny";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("resolves table-only configurations for reads, writes and links", async () => {
  const requests: string[] = [];
  replaceFetch(async (url, init) => {
    expect(url.origin).toBe("http://93.184.216.34");
    expect(new Headers(init?.headers).get("xc-token")).toBe("test-token");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v2/meta/tables/table")
      return Response.json({ base_id: "base" });
    if (url.pathname.includes("/api/v3/meta/"))
      return Response.json({
        fields: [{ id: "relation", title: "Related", type: "Links" }],
      });
    if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
    if (url.pathname.endsWith("/links/relation/first")) return Response.json({});
    return Response.json({
      records: [{ id: "first", fields: { Name: "Alice" } }],
      next: null,
    });
  });
  const configuration = {
    baseUrl: "http://93.184.216.34",
    tableId: "table",
    apiKey: "test-token",
  };
  const client = createNocoDbClient(configuration);
  const result = await client.list({ limit: "1" });
  expect(result.list).toEqual([{ Id: "first", Name: "Alice" }]);
  expect(result.pageInfo.totalRows).toBe(1);
  expect(await client.create({ Name: "Alice" })).toEqual({ Id: "first" });
  await client.update([{ Id: "first", Name: "Bob" }]);
  expect(requests.filter((request) => request.includes("/api/v2/"))).toEqual([
    "GET /api/v2/meta/tables/table",
  ]);
  await linkRelationUpdatesIfAny({
    ...configuration,
    updates: [{ fieldName: "Related", value: "42" }],
    recordIdsToUpdate: ["first"],
  });
  expect(requests.filter((request) => request.includes("/api/v3/data/"))).toEqual([
    "GET /api/v3/data/base/table/records",
    "GET /api/v3/data/base/table/count",
    "POST /api/v3/data/base/table/records",
    "PATCH /api/v3/data/base/table/records",
    "POST /api/v3/data/base/table/links/relation/first",
  ]);
});

it("rejects missing discovery metadata before writing", async () => {
  const methods: string[] = [];
  replaceFetch(async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json({});
  });
  await expect(createNocoDbClient({
    baseUrl: "http://93.184.216.34",
    tableId: "table",
    apiKey: "test-token",
  }).create({ Name: "Alice" })).rejects.toThrow("configure Base ID explicitly");
  expect(methods).toEqual(["GET"]);
});

it("preserves the custom host and token and wraps writes without replacing links", async () => {
  const writes: { method?: string; body: unknown }[] = [];
  replaceFetch(async (url, init) => {
    expect(url.origin).toBe("http://93.184.216.34");
    expect(new Headers(init?.headers).get("xc-token")).toBe("test-token");
    expect(url.pathname.startsWith("/api/v2/")).toBe(false);
    if (url.pathname.includes("/meta/")) {
      return Response.json({
        fields: [{ id: "relation", title: "Related", type: "Links" }],
      });
    }
    expect(url.pathname).toBe("/api/v3/data/base/table/records");
    writes.push({
      method: init?.method,
      body: await new Response(init?.body).json(),
    });
    return Response.json({ records: [{ id: "created-id", fields: {} }] });
  });
  const client = createClient();
  expect(await client.create({ Name: "Alice", Related: "42" })).toEqual({
    Id: "created-id",
  });
  await client.update([
    { Id: "first", Name: null, Related: "42" },
    { Id: "second", Name: "Bob" },
    { Id: "third", Related: "43" },
  ]);
  expect(writes).toEqual([
    { method: "POST", body: { fields: { Name: "Alice" } } },
    { method: "PATCH", body: { id: "first", fields: { Name: null } } },
    { method: "PATCH", body: { id: "second", fields: { Name: "Bob" } } },
  ]);
});

it("handles server page caps and restores field titles, primary keys and total rows", async () => {
  const offsets: string[] = [];
  replaceFetch(async (url) => {
    if (url.pathname.includes("/meta/")) return Response.json({ fields: [] });
    expect(url.searchParams.get("where")).toBe("(Name,neq,Bob)");
    expect(url.searchParams.get("viewId")).toBe("view");
    if (url.pathname.endsWith("/count")) return Response.json({ count: 7 });
    const offset = url.searchParams.get("offset") ?? "";
    offsets.push(offset);
    expect(url.searchParams.get("limit")).toBe(offset === "0" ? "2" : "1");
    return Response.json({
      records: [{
        id: offset === "0" ? "first" : "second",
        id_fields: { ExternalKey: offset },
        fields: { Name: "Alice" },
      }],
      next: "/another-page",
    });
  });
  const result = await createClient().list({
    where: "(Name,neq,Bob)",
    viewId: "view",
    limit: "2",
  });
  expect(offsets).toEqual(["0", "1"]);
  expect(result.list).toEqual([
    { Id: "first", ExternalKey: "0", Name: "Alice" },
    { Id: "second", ExternalKey: "1", Name: "Alice" },
  ]);
  expect(result.pageInfo.totalRows).toBe(7);
});

it("returns records when optional table metadata is forbidden without weakening writes", async () => {
  const paths: string[] = [];
  const related = { id: "related", fields: { Name: "Bob" } };
  replaceFetch(async (url) => {
    paths.push(url.pathname);
    if (url.pathname.includes("/meta/"))
      return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    if (url.pathname.endsWith("/count")) return Response.json({ count: 7 });
    return Response.json({
      records: [{
        id: "first",
        id_fields: { ExternalKey: "external" },
        fields: { Name: "Alice", Related: [related] },
      }],
      next: null,
    });
  });
  const client = createClient();
  const result = await client.list({ limit: "1" });
  expect(result.list).toEqual([{
    Id: "first",
    ExternalKey: "external",
    Name: "Alice",
    Related: [related],
  }]);
  expect(result.pageInfo.totalRows).toBe(7);
  expect(paths).toEqual([
    "/api/v3/data/base/table/records",
    "/api/v3/data/base/table/count",
    "/api/v3/meta/bases/base/tables/table",
  ]);
  await expect(client.create({ Name: "Alice" })).rejects.toMatchObject({
    response: { status: 403 },
  });
  expect(paths).toHaveLength(3);
});

it("preserves relation enrichment when table metadata is available", async () => {
  replaceFetch(async (url) => {
    if (url.pathname.includes("/meta/"))
      return Response.json({
        fields: [{ id: "relation", title: "Related", type: "LinkToAnotherRecord" }],
      });
    if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
    return Response.json({
      records: [{
        id: "first",
        fields: {
          Related: [{ id: "related", fields: { Name: "Bob" } }],
        },
      }],
      next: null,
    });
  });
  const result = await createClient().list({ limit: "1" });
  expect(result.list).toEqual([{
    Id: "first",
    Related: [{ Id: "related", Name: "Bob" }],
  }]);
});

it.each(["records", "count"])(
  "propagates forbidden %s requests",
  async (forbiddenEndpoint) => {
    replaceFetch(async (url) => {
      if (url.pathname.endsWith(`/${forbiddenEndpoint}`))
        return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      if (url.pathname.endsWith("/count")) return Response.json({ count: 0 });
      return Response.json({ records: [], next: null });
    });
    await expect(createClient().list({ limit: "1" })).rejects.toMatchObject({
      response: { status: 403 },
    });
  },
);

const createClient = () => createNocoDbClient({
  baseUrl: "http://93.184.216.34",
  baseId: "base",
  tableId: "table",
  apiKey: "test-token",
});

const replaceFetch = (
  implementation: (url: URL, init?: RequestInit) => Promise<Response>,
) => {
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url;
      return implementation(new URL(url), init);
    },
    { preconnect: originalFetch.preconnect },
  );
};
