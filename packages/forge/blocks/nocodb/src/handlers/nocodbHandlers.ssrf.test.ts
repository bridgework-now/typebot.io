import { afterEach, describe, expect, it } from "bun:test";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { getSafeDispatcher } from "@typebot.io/lib/ssrf/createSafeDispatcher";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { listNocoDbRecords } from "../helpers/listNocoDbRecords";
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
      if (init?.method === "POST") return Response.json({ success: true });
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

describe("NocoDB v3 migration", () => {
  for (const handler of handlers) {
    it(`discovers the base for saved ${handler.name} actions without baseId`, async () => {
      const requestedUrls: string[] = [];
      replaceFetch(async (input, init) => {
        requestedUrls.push(getRequestUrl(input));
        return createNocoDbResponse(input, init);
      });

      expect(await handler.execute("http://93.184.216.34", true)).toEqual([]);
      expect(requestedUrls).toContain(
        "http://93.184.216.34/api/v2/meta/tables/table-id",
      );
      expect(requestedUrls.some((url) =>
        new URL(url).pathname === "/api/v3/data/base-id/table-id/records",
      )).toBe(true);
    });
  }

  it("preserves an explicit base ID and maps records with omitted fields", async () => {
    const requestedUrls: string[] = [];
    replaceFetch(async (input, init) => {
      requestedUrls.push(getRequestUrl(input));
      return createNocoDbResponse(input, init);
    });

    const result = await listNocoDbRecords({
      baseUrl: "http://93.184.216.34",
      apiKey: "test-api-key",
      baseId: "configured-base",
      tableId: "table-id",
      where: undefined,
      viewId: undefined,
    });

    expect(result.list).toEqual([{ Key: 1 }]);
    expect(result.recordIds).toEqual([1]);
    expect(requestedUrls.some((url) =>
      new URL(url).pathname === "/api/v3/data/configured-base/table-id/records",
    )).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/data/base-id/"))).toBe(false);
  });

  it("wraps create fields and keeps the configured server", async () => {
    const writes: { url: string; body: unknown }[] = [];
    replaceFetch(async (input, init) => {
      if (init?.method === "POST") {
        writes.push({
          url: getRequestUrl(input),
          body: await new Response(init.body).json(),
        });
      }
      return createNocoDbResponse(input, init);
    });

    expect(await executeCreateRecord("http://93.184.216.34")).toEqual([]);
    expect(writes).toEqual([
      {
        url: "http://93.184.216.34/api/v3/data/base-id/table-id/records",
        body: { fields: { Name: "Alice" } },
      },
    ]);
  });

  it("updates using the envelope id rather than a field named Id", async () => {
    const writes: unknown[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      if (init?.method === "GET" && url.pathname.endsWith("/records"))
        return Response.json({
          records: [{ id: "row-key", fields: { Id: 99, Name: "Alice" } }],
          next: null,
        });
      if (init?.method === "PATCH")
        writes.push(await new Response(init.body).json());
      return createNocoDbResponse(input, init);
    });

    expect(await executeUpdateExistingRecord("http://93.184.216.34")).toEqual([]);
    expect(writes).toEqual([
      [{ id: "row-key", fields: { Name: "Bob" } }],
    ]);
  });

  it("pages through a server cap and restores primary-key field names", async () => {
    const requestedUrls: URL[] = [];
    replaceFetch(async (input) => {
      const url = new URL(getRequestUrl(input));
      requestedUrls.push(url);
      if (url.pathname.includes("/api/v2/meta/tables/"))
        return Response.json({
          base_id: "base-id",
          columns: [{ title: "Key", pk: true }],
        });
      if (url.pathname.endsWith("/count"))
        return Response.json({ count: 2 });
      const page = Number(url.searchParams.get("page"));
      return Response.json({
        records: [{
          id: `row-${page}`,
          fields: { Name: page === 1 ? "Alice" : "Bob" },
        }],
        next: page === 1 ? "https://other.example/records?page=2" : null,
      });
    });

    const result = await listNocoDbRecords({
      baseUrl: "http://93.184.216.34",
      apiKey: "test-api-key",
      baseId: "base-id",
      tableId: "table-id",
      where: "(Name,neq,Charlie)",
      viewId: "view-id",
    });

    expect(result).toEqual({
      list: [
        { Key: "row-1", Name: "Alice" },
        { Key: "row-2", Name: "Bob" },
      ],
      recordIds: ["row-1", "row-2"],
      pageInfo: { totalRows: 2 },
    });
    expect(requestedUrls).toHaveLength(4);
    expect(requestedUrls.slice(1).every((url) =>
      url.origin === "http://93.184.216.34" &&
      url.searchParams.get("viewId") === "view-id" &&
      url.searchParams.get("where") === "(Name,neq,Charlie)",
    )).toBe(true);
    expect(requestedUrls.slice(2).map((url) => url.searchParams.get("page")))
      .toEqual(["1", "2"]);
  });

  it("uses the v3 not-equal operator", () => {
    expect(convertFilterToWhereClause({
      comparisons: [{ input: "Name", operator: "Not equal", value: "Alice" }],
    })).toBe("(Name,neq,Alice)");
  });

  it("sends additive links with lowercase ids", async () => {
    const writes: unknown[] = [];
    replaceFetch(async (_input, init) => {
      if (init?.method === "POST") {
        writes.push(await new Response(init.body).json());
        return Response.json({ success: true });
      }
      return Response.json({ fields: [{
        id: "relation-column",
        title: "Related record",
        type: "LinkToAnotherRecord",
      }] });
    });

    await executeRelationUpdates("http://93.184.216.34");
    expect(writes).toEqual([[{ id: "42" }]]);
  });
});

const executeCreateRecord = async (baseUrl: string, legacy = false) => {
  const errors: string[] = [];
  await createRecordHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      ...(legacy ? {} : { baseId: "base-id" }),
      tableId: "table-id",
      fields: [{ key: "Name", value: "Alice" }],
    }),
    variables: createVariablesStore(),
    logs: createLogsStore(errors),
    sessionStore: Object.create(null),
  });
  return errors;
};

const executeSearchRecords = async (baseUrl: string, legacy = false) => {
  const errors: string[] = [];
  await searchRecordsHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      ...(legacy ? {} : { baseId: "base-id" }),
      tableId: "table-id",
    }),
    variables: createVariablesStore(),
    logs: createLogsStore(errors),
    sessionStore: Object.create(null),
  });
  return errors;
};

const executeUpdateExistingRecord = async (baseUrl: string, legacy = false) => {
  const errors: string[] = [];
  await updateExistingRecordHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      ...(legacy ? {} : { baseId: "base-id" }),
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
  if (url.pathname.includes("/api/v2/meta/tables/"))
    return Response.json({
      base_id: "base-id",
      columns: [{ title: "Key", pk: 1 }],
    });
  if (url.pathname.includes("/api/v3/meta/bases/"))
    return Response.json({ base_id: "base-id", fields: [] });
  if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
  if (init?.method === "POST")
    return Response.json({ records: [{ id: 1, fields: {} }] });
  if (init?.method === "GET")
    return Response.json({
      records: [{ id: 1 }],
      next: null,
    });
  return new Response(null, { status: 200 });
};
