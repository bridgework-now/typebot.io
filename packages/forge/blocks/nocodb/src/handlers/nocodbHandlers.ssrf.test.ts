import { afterEach, describe, expect, it } from "bun:test";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { getSafeDispatcher } from "@typebot.io/lib/ssrf/createSafeDispatcher";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { createNocoDbClient } from "../helpers/createNocoDbClient";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { createRecordHandler } from "./createRecordHandler";
import { searchRecordsHandler } from "./searchRecordsHandler";
import { updateExistingRecordHandler } from "./updateExistingRecordHandler";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NocoDB handlers SSRF protection", () => {
  for (const handler of handlers) {
    it(`blocks ${handler.name} requests to private targets`, async () => {
      let requestCount = 0;
      replaceFetch(async () => {
        requestCount++;
        return Response.json({});
      });

      const errors = await handler.execute("http://127.0.0.1:3000");

      expect(requestCount).toBe(0);
      expect(errors.join(" ")).toContain("loopback addresses");
    });

    it(`blocks ${handler.name} redirects to private targets`, async () => {
      const requestedUrls: string[] = [];
      replaceFetch(async (input) => {
        requestedUrls.push(getRequestUrl(input));
        return new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      });

      const errors = await handler.execute("http://93.184.216.34");

      expect(requestedUrls.length).toBeGreaterThan(0);
      expect(
        requestedUrls.every((url) => url.startsWith("http://93.184.216.34/")),
      ).toBe(true);
      expect(errors.join(" ")).toContain("link-local addresses");
    });

    it(`uses the DNS-validating dispatcher for every ${handler.name} request`, async () => {
      const dispatchers: unknown[] = [];
      replaceFetch(async (input, init) => {
        dispatchers.push(
          init && "dispatcher" in init ? init.dispatcher : undefined,
        );
        return createNocoDbResponse(input, init);
      });

      const errors = await handler.execute("http://93.184.216.34");

      expect(errors).toEqual([]);
      expect(dispatchers.length).toBeGreaterThan(0);
      expect(dispatchers.every((item) => item === getSafeDispatcher())).toBe(
        true,
      );
    });
  }
});

describe("NocoDB relation requests SSRF protection", () => {
  it("blocks relation metadata requests to private targets", async () => {
    let requestCount = 0;
    replaceFetch(async () => {
      requestCount++;
      return Response.json({});
    });

    await expect(executeRelationUpdates("http://10.0.0.1")).rejects.toThrow(
      "10.0.0.0/8",
    );
    expect(requestCount).toBe(0);
  });

  it("blocks relation redirects to private targets", async () => {
    const requestedUrls: string[] = [];
    replaceFetch(async (input) => {
      requestedUrls.push(getRequestUrl(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      });
    });

    await expect(
      executeRelationUpdates("http://93.184.216.34"),
    ).rejects.toThrow("loopback addresses");
    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(
      requestedUrls.every((url) => url.startsWith("http://93.184.216.34/")),
    ).toBe(true);
  });

  it("uses the DNS-validating dispatcher for metadata and link updates", async () => {
    const requestedUrls: string[] = [];
    const dispatchers: unknown[] = [];
    replaceFetch(async (input, init) => {
      requestedUrls.push(getRequestUrl(input));
      dispatchers.push(
        init && "dispatcher" in init ? init.dispatcher : undefined,
      );
      if (init?.method === "POST") return Response.json({});
      return Response.json({
        fields: [
          {
            id: "relation-column",
            title: "Related record",
            type: "LinkToAnotherRecord",
          },
        ],
      });
    });

    await executeRelationUpdates("http://93.184.216.34");

    expect(requestedUrls).toEqual([
      "http://93.184.216.34/api/v3/meta/bases/base-id/tables/table-id",
      "http://93.184.216.34/api/v3/data/base-id/table-id/links/relation-column/1",
    ]);
    expect(dispatchers).toEqual([getSafeDispatcher(), getSafeDispatcher()]);
  });
});

describe("NocoDB v3 compatibility", () => {
  const createClient = () =>
    createNocoDbClient({
      baseUrl: "http://93.184.216.34",
      apiKey: "test-api-key",
      baseId: "base-id",
      tableId: "table-id",
    });

  it("preserves mappings and totals across capped pages without following response URLs", async () => {
    const urls: URL[] = [];
    replaceFetch(async (input) => {
      const url = new URL(getRequestUrl(input));
      urls.push(url);
      if (url.pathname.includes("/meta/"))
        return Response.json({
          fields: [{ id: "related", title: "Related", type: "Links" }],
        });
      if (url.pathname.endsWith("/count")) return Response.json({ count: 20 });
      const offset = Number(url.searchParams.get("offset"));
      return Response.json({
        records: [{
          id: `record-${offset}`,
          id_fields: { Key: `record-${offset}` },
          fields: {
            Name: `Name ${offset}`,
            Related: [{ id: 42, fields: { Name: "Related name" } }],
          },
        }],
        next: "http://127.0.0.1/private",
      });
    });

    const result = await createClient().list({
      where: '("Name",neq,"Bob")',
      viewId: "view-id",
      limit: 2,
    });

    expect(result.list).toEqual([0, 1].map((offset) => ({
      Id: `record-${offset}`,
      Key: `record-${offset}`,
      Name: `Name ${offset}`,
      Related: [{ Id: 42, Name: "Related name" }],
    })));
    expect(result.pageInfo.totalRows).toBe(20);
    expect(urls.every((url) => url.origin === "http://93.184.216.34")).toBe(true);
    const recordUrls = urls.filter((url) => url.pathname.endsWith("/records"));
    expect(recordUrls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "1"]);
    expect(recordUrls.every((url) => url.searchParams.get("viewId") === "view-id")).toBe(true);
    expect(urls.at(-1)?.searchParams.get("where")).toBe('("Name",neq,"Bob")');
  });

  it("uses v3 write envelopes and adds links separately", async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    replaceFetch(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      expect(request.headers.get("xc-token")).toBe("test-api-key");
      if (path.includes("/meta/"))
        return Response.json({
          fields: [{ id: "related", title: "Related", type: "Links" }],
        });
      writes.push({ method: request.method, path, body: await request.json() });
      return Response.json({ records: [{ id: "created-id", fields: {} }], success: true });
    });

    const client = createClient();
    expect(await client.create({ Name: "Alice", Related: "42" })).toEqual({ Id: "created-id" });
    await client.update([
      { Id: "created-id", Name: null, Related: "42" },
      { Id: "second-id", Name: "Bob" },
    ]);
    await client.link("related", "created-id", ["42"]);

    expect(writes).toEqual([
      { method: "POST", path: "/api/v3/data/base-id/table-id/records", body: { fields: { Name: "Alice" } } },
      { method: "PATCH", path: "/api/v3/data/base-id/table-id/records", body: { id: "created-id", fields: { Name: null } } },
      { method: "PATCH", path: "/api/v3/data/base-id/table-id/records", body: { id: "second-id", fields: { Name: "Bob" } } },
      { method: "POST", path: "/api/v3/data/base-id/table-id/links/related/created-id", body: [{ id: "42" }] },
    ]);
  });

  it("logs a missing base ID before making requests", async () => {
    let requests = 0;
    replaceFetch(async () => {
      requests++;
      return Response.json({});
    });
    const errors: string[] = [];
    await createRecordHandler.server?.({
      credentials: { apiKey: "test-api-key" },
      options: Object.assign(Object.create(null), {
        tableId: "table-id",
        fields: [{ key: "Name", value: "Alice" }],
      }),
      variables: createVariablesStore(),
      logs: createLogsStore(errors),
      sessionStore: Object.create(null),
    });
    expect(requests).toBe(0);
    expect(errors.join(" ")).toContain("Base ID is required");
  });

  it("quotes filter delimiters and uses the documented inequality operator", () => {
    expect(convertFilterToWhereClause({
      comparisons: [{ input: "Product Name", operator: "Not equal", value: "Laptop, 15-inch" }],
    })).toBe('("Product Name",neq,"Laptop, 15-inch")');
    expect(convertFilterToWhereClause({
      comparisons: [{ input: "Name", operator: "Starts with", value: "Al" }],
    })).toBe('("Name",like,"Al%")');
  });
});

const executeCreateRecord = async (baseUrl: string) => {
  const errors: string[] = [];
  await createRecordHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      baseId: "base-id",
      tableId: "table-id",
      fields: [{ key: "Name", value: "Alice" }],
    }),
    variables: createVariablesStore(),
    logs: createLogsStore(errors),
    sessionStore: Object.create(null),
  });
  return errors;
};

const executeSearchRecords = async (baseUrl: string) => {
  const errors: string[] = [];
  await searchRecordsHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      baseId: "base-id",
      tableId: "table-id",
    }),
    variables: createVariablesStore(),
    logs: createLogsStore(errors),
    sessionStore: Object.create(null),
  });
  return errors;
};

const executeUpdateExistingRecord = async (baseUrl: string) => {
  const errors: string[] = [];
  await updateExistingRecordHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      baseId: "base-id",
      tableId: "table-id",
      filter: {
        comparisons: [{ input: "Name", operator: "Equal", value: "Alice" }],
      },
      updates: [{ fieldName: "Name", value: "Bob" }],
    }),
    variables: createVariablesStore(),
    logs: createLogsStore(errors),
    sessionStore: Object.create(null),
  });
  return errors;
};

const handlers = [
  { name: "create record", execute: executeCreateRecord },
  { name: "search records", execute: executeSearchRecords },
  { name: "update existing record", execute: executeUpdateExistingRecord },
];

const executeRelationUpdates = (baseUrl: string) =>
  linkRelationUpdatesIfAny({
    baseUrl,
    apiKey: "test-api-key",
    baseId: "base-id",
    tableId: "table-id",
    updates: [{ fieldName: "Related record", value: "42" }],
    recordIdsToUpdate: [1],
  });

const createVariablesStore = (): VariableStore => ({
  get: () => undefined,
  set: () => {},
  parse: (value) => value,
  list: () => [],
});

const createLogsStore = (errors: string[]): LogsStore => ({
  add: (log) => {
    errors.push(typeof log === "string" ? log : log.description);
  },
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

const createNocoDbResponse = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = new URL(getRequestUrl(input));
  if (url.pathname.includes("/api/v3/meta/"))
    return Response.json({ fields: [] });
  if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
  if (init?.method === "POST")
    return Response.json({ records: [{ id: 1, fields: {} }] });
  if (init?.method === "GET")
    return Response.json({ records: [{ id: 1, fields: {} }], next: null });
  return new Response(null, { status: 200 });
};
