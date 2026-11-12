import { afterEach, describe, expect, it } from "bun:test";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { getSafeDispatcher } from "@typebot.io/lib/ssrf/createSafeDispatcher";
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

describe("NocoDB v3 request contracts", () => {
  it("wraps create fields and uses the configured host", async () => {
    const writes: { url: string; body: unknown }[] = [];
    replaceFetch(async (input, init) => {
      const url = getRequestUrl(input);
      if (init?.method === "POST") {
        writes.push({ url, body: await new Response(init.body).json() });
        return Response.json({ records: [{ id: "created-id", fields: {} }] });
      }
      return Response.json({ fields: [] });
    });
    expect(await executeCreateRecord("http://93.184.216.34")).toEqual([]);
    expect(writes).toEqual([{
      url: "http://93.184.216.34/api/v3/data/base-id/table-id/records",
      body: { fields: { Name: "Alice" } },
    }]);
  });

  it("updates more than ten matches using single-record v3 requests", async () => {
    const writes: unknown[] = [];
    replaceFetch(async (input, init) => {
      const url = new URL(getRequestUrl(input));
      if (init?.method === "PATCH") {
        expect(url.pathname).toBe("/api/v3/data/base-id/table-id/records");
        writes.push(await new Response(init.body).json());
        return Response.json({ records: [] });
      }
      if (url.pathname.includes("/meta/")) return Response.json({ fields: [] });
      if (url.pathname.endsWith("/count")) return Response.json({ count: 12 });
      return Response.json({
        records: Array.from({ length: 12 }, (_, index) => ({
          id: `record-${index}`,
          fields: { Name: "Alice" },
        })),
        next: null,
      });
    });
    expect(await executeUpdateExistingRecord("http://93.184.216.34")).toEqual([]);
    expect(writes).toEqual(Array.from({ length: 12 }, (_, index) => ({
      id: `record-${index}`,
      fields: { Name: "Bob" },
    })));
  });

  it("sends lowercase link identifiers without replacing existing links", async () => {
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
