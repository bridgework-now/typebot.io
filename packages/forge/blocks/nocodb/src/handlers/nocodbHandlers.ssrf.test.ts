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

describe("NocoDB v3 request contracts", () => {
  it("wraps create fields and uses the configured host", async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    replaceFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        body: request.method === "POST" ? await request.clone().json() : undefined,
      });
      return createNocoDbResponse(input, init);
    });

    expect(await executeCreateRecord("http://93.184.216.34")).toEqual([]);
    expect(requests[0]).toEqual({
      url: "http://93.184.216.34/api/v3/data/base-id/table-id/records",
      method: "POST",
      body: { fields: { Name: "Alice" } },
    });
  });

  it("uses v3 record IDs and nested fields for updates", async () => {
    const bodies: unknown[] = [];
    replaceFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PATCH") {
        expect(request.url).toBe(
          "http://93.184.216.34/api/v3/data/base-id/table-id/records",
        );
        bodies.push(await request.clone().json());
      }
      return createNocoDbResponse(input, init);
    });

    expect(await executeUpdateExistingRecord("http://93.184.216.34")).toEqual([]);
    expect(bodies).toEqual([[{ id: 1, fields: { Name: "Bob" } }]]);
  });
});

describe("NocoDB v3 pagination", () => {
  for (const returnType of ["All", "First", "Last"] as const) {
    it(`maps ${returnType} across capped pages, including named composite keys`, async () => {
      const records = Array.from({ length: 101 }, (_, index) => ({
        id: `tenant:${index + 1}`,
        id_fields: { Tenant: "tenant", ExternalId: index + 1 },
        fields: { Name: `Record ${index + 1}` },
      }));
      const requestedPages: number[] = [];
      replaceFetch(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        expect(url.pathname).toBe("/api/v3/data/base-id/table-id/records");
        expect(request.headers.get("xc-token")).toBe("test-api-key");
        const page = Number(url.searchParams.get("page") ?? "1");
        requestedPages.push(page);
        url.searchParams.set("page", "2");
        return Response.json({
          records: page === 1 ? records.slice(0, 100) : records.slice(100),
          next: page === 1 ? url.href : null,
        });
      });
      const mappedValues: unknown[] = [];
      const variables = createVariablesStore();
      variables.set = (values) => {
        mappedValues.push(...values);
      };

      expect(
        await executeSearchRecords("http://93.184.216.34", returnType, variables),
      ).toEqual([]);
      expect(requestedPages).toEqual([1, 2]);
      const selectedRecords =
        returnType === "All"
          ? records
          : [records[returnType === "First" ? 0 : 100]!];
      expect(mappedValues).toEqual(
        ["Id", "Tenant", "ExternalId"].map((fieldName) => {
          const values = selectedRecords.map((record) => {
            if (fieldName === "Id") return record.id;
            if (fieldName === "Tenant") return record.id_fields.Tenant;
            return record.id_fields.ExternalId;
          });
          return {
            id: fieldName,
            value: values.length === 1 ? values[0] : values,
          };
        }),
      );
    });
  }

  it("reads every page before writing and updates all 101 matches in capped batches", async () => {
    const records = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      fields: {},
    }));
    const requestedPages: number[] = [];
    const bodies: unknown[] = [];
    replaceFetch(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/records") && request.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? "1");
        requestedPages.push(page);
        url.searchParams.set("page", "2");
        return Response.json({
          records: page === 1 ? records.slice(0, 100) : records.slice(100),
          next: page === 1 ? url.href : null,
        });
      }
      if (request.method === "PATCH") {
        expect(requestedPages).toEqual([1, 2]);
        expect(request.headers.get("xc-token")).toBe("test-api-key");
        bodies.push(await request.json());
      }
      return createNocoDbResponse(input, init);
    });

    expect(await executeUpdateExistingRecord("http://93.184.216.34")).toEqual([]);
    expect(bodies).toEqual(
      Array.from({ length: 11 }, (_, batchIndex) =>
        records.slice(batchIndex * 10, batchIndex * 10 + 10).map(({ id }) => ({
          id,
          fields: { Name: "Bob" },
        })),
      ),
    );
  });

  it("rejects pagination to a different origin before forwarding the token", async () => {
    let requestCount = 0;
    replaceFetch(async () => {
      requestCount++;
      return Response.json({
        records: [],
        next: "https://example.com/api/v3/data/base-id/table-id/records?page=2",
      });
    });

    const errors = await executeSearchRecords("http://93.184.216.34");
    expect(requestCount).toBe(1);
    expect(errors.join(" ")).toContain("unexpected pagination URL");
  });
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

const executeSearchRecords = async (
  baseUrl: string,
  returnType?: "All" | "First" | "Last",
  variables = createVariablesStore(),
) => {
  const errors: string[] = [];
  await searchRecordsHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
      baseId: "base-id",
      tableId: "table-id",
      returnType,
      responseMapping: ["Id", "Tenant", "ExternalId"].map((fieldName) => ({
        fieldName,
        variableId: fieldName,
      })),
    }),
    variables,
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
    baseId: "base-id",
    baseUrl,
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
  if (init?.method === "POST") return Response.json({ records: [{ id: 1 }] });
  if (init?.method === "GET")
    return Response.json({
      records: [{ id: 1, fields: {} }],
      next: null,
    });
  return new Response(null, { status: 200 });
};
