import { afterEach, describe, expect, it } from "bun:test";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { getSafeDispatcher } from "@typebot.io/lib/ssrf/createSafeDispatcher";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { createNocoDbClient } from "../helpers/createNocoDbClient";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
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

describe("NocoDB API v3 migration", () => {
  it("retains filters, total count, primary keys and the 1000-record bound", async () => {
    const offsets: number[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      expect(new Headers(init?.headers).get("xc-token")).toBe("test-api-key");
      expect(url.origin).toBe("http://93.184.216.34");
      expect(url.searchParams.get("where")).toBe("(Name,neq,Bob)");
      expect(url.searchParams.get("viewId")).toBe("view-id");
      if (url.pathname.endsWith("/count"))
        return Response.json({ count: 1001 });
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      expect(url.searchParams.get("limit")).toBe("100");
      return Response.json({
        records: Array.from({ length: 100 }, (_, index) => ({
          id: `record-${offset + index}`,
          id_fields: { CustomKey: `record-${offset + index}` },
          fields: { Name: "Alice" },
        })),
        next: "https://untrusted.example/records?page=2",
      });
    });

    const data = await createNocoDbClient({
      baseUrl: "http://93.184.216.34",
      baseId: "base-id",
      tableId: "table-id",
      apiKey: "test-api-key",
    }).listRecords({
      where: "(Name,neq,Bob)",
      viewId: "view-id",
      limit: "1000",
    });

    expect(offsets).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(data.list).toHaveLength(1000);
    expect(data.list[0]).toEqual({
      Id: "record-0",
      CustomKey: "record-0",
      Name: "Alice",
    });
    expect(data.pageInfo.totalRows).toBe(1001);
    expect(data.pageInfo.isLastPage).toBe(false);
  });

  it("wraps update fields, batches writes and leaves links for additive updates", async () => {
    const bodies: unknown[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      if (url.pathname.includes("/api/v3/meta/"))
        return Response.json({
          fields: [{ id: "relation-column", title: "Related record", type: "Links" }],
        });
      expect(init?.method).toBe("PATCH");
      bodies.push(await new Response(init?.body).json());
      return Response.json({ records: [] });
    });

    const client = createNocoDbClient({
      baseUrl: "http://93.184.216.34",
      baseId: "base-id",
      tableId: "table-id",
      apiKey: "test-api-key",
    });
    await client.updateRecords(
      Array.from({ length: 23 }, (_, index) => ({
        Id: `record-${index}`,
        Name: "Bob",
        "Related record": "42",
      })),
    );
    expect(bodies).toEqual(
      [0, 10, 20].map((offset) =>
        Array.from({ length: Math.min(10, 23 - offset) }, (_, index) => ({
          id: `record-${offset + index}`,
          fields: { Name: "Bob" },
        })),
      ),
    );
    await client.updateRecords([{ Id: "record-0", "Related record": "42" }]);
    await client.updateRecords([]);
    expect(bodies).toHaveLength(3);
  });

  it("creates a record and appends relations using the returned v3 id", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      if (url.pathname.includes("/api/v3/meta/"))
        return Response.json({
          fields: [{ id: "relation-column", title: "Related record", type: "LinkToAnotherRecord" }],
        });
      writes.push({ path: url.pathname, body: await new Response(init?.body).json() });
      if (url.pathname.endsWith("/records"))
        return Response.json({ records: [{ id: "new-record", fields: { Name: "Alice" } }] });
      return Response.json({ success: true });
    });

    const errors: string[] = [];
    await createRecordHandler.server?.({
      credentials: { baseUrl: "http://93.184.216.34", apiKey: "test-api-key" },
      options: Object.assign(Object.create(null), {
        baseId: "base-id",
        tableId: "table-id",
        fields: [
          { key: "Name", value: "Alice" },
          { key: "Related record", value: '["42","43"]' },
        ],
      }),
      variables: createVariablesStore(),
      logs: createLogsStore(errors),
      sessionStore: Object.create(null),
    });
    expect(errors).toEqual([]);
    expect(writes).toEqual([
      {
        path: "/api/v3/data/base-id/table-id/records",
        body: { fields: { Name: "Alice" } },
      },
      {
        path: "/api/v3/data/base-id/table-id/links/relation-column/new-record",
        body: [{ id: "42" }, { id: "43" }],
      },
    ]);
  });

  it("uses the documented v3 inequality operator", () => {
    expect(
      convertFilterToWhereClause({
        comparisons: [{ input: "Name", operator: "Not equal", value: "Bob" }],
      }),
    ).toBe("(Name,neq,Bob)");
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
    baseId: "base-id",
    apiKey: "test-api-key",
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
  if (url.pathname.includes("/api/v3/meta/bases/"))
    return Response.json({ fields: [] });
  if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
  if (init?.method === "POST")
    return Response.json({ records: [{ id: 1, fields: {} }] });
  if (init?.method === "GET")
    return Response.json({
      records: [{ id: 1, fields: {} }],
      next: null,
    });
  return new Response(null, { status: 200 });
};
