import { afterEach, describe, expect, it } from "bun:test";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { getSafeDispatcher } from "@typebot.io/lib/ssrf/createSafeDispatcher";
import { createNocoDbTableClient } from "../helpers/createNocoDbTableClient";
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
        base_id: "base-id",
        columns: [
          {
            id: "relation-column",
            title: "Related record",
            uidt: "LinkToAnotherRecord",
          },
        ],
      });
    });

    await executeRelationUpdates("http://93.184.216.34");

    expect(requestedUrls).toEqual([
      "http://93.184.216.34/api/v2/meta/tables/table-id",
      "http://93.184.216.34/api/v3/data/base-id/table-id/links/relation-column/1",
    ]);
    expect(dispatchers).toEqual([getSafeDispatcher(), getSafeDispatcher()]);
  });
});

describe("NocoDB v3 migration", () => {
  it("uses the default host, configured base ID, token and create envelope", async () => {
    const urls: string[] = [];
    replaceFetch(async (input, init) => {
      const url = getRequestUrl(input);
      urls.push(url);
      expect(new Headers(init?.headers).get("xc-token")).toBe("test-api-key");
      if (init?.method === "GET")
        return Response.json({ base_id: "base-id", fields: [] });
      expect(await new Response(init?.body).json()).toEqual({
        fields: { Name: "Alice" },
      });
      return Response.json({ records: [{ id: "record-id", fields: {} }] });
    });

    const client = await createNocoDbTableClient({
      baseUrl: undefined,
      baseId: "base-id",
      tableId: "table-id",
      apiKey: "test-api-key",
    });
    expect(await client.createRecord({ Name: "Alice" })).toEqual({
      Id: "record-id",
    });
    expect(urls).toEqual([
      "https://app.nocodb.com/api/v3/meta/bases/base-id/tables/table-id",
      "https://app.nocodb.com/api/v3/data/base-id/table-id/records",
    ]);
  });

  it("preserves bounded searches, filters, total rows and flat field mappings", async () => {
    const offsets: string[] = [];
    replaceFetch(async (input) => {
      const url = new URL(getRequestUrl(input));
      if (url.pathname.includes("/meta/"))
        return Response.json({
          base_id: "base-id",
          fields: [
            { id: "relation-column", title: "Related", type: "LinkToAnotherRecord" },
            { id: "json-column", title: "Payload", type: "JSON" },
            { id: "json-array-column", title: "Payloads", type: "JSON" },
          ],
        });
      expect(url.origin).toBe("http://93.184.216.34");
      expect(url.searchParams.get("where")).toBe("(Name,neq,Bob)");
      expect(url.searchParams.get("viewId")).toBe("view-id");
      if (url.pathname.endsWith("/count"))
        return Response.json({ count: 7 });
      const offset = url.searchParams.get("offset")!;
      offsets.push(offset);
      return Response.json({
        records: [{
          id: Number(offset) + 1,
          id_fields: { Id: Number(offset) + 1 },
          fields: {
            Name: "Alice",
            Related: [{
              id: "related-id",
              fields: {
                Name: "Bob",
                Payload: { id: 9, fields: { status: "nested" }, extra: true },
              },
            }],
            Payload: { id: 7, fields: { status: "ok" }, extra: "keep" },
            Payloads: [{ id: 8, fields: { status: "ok" }, extra: "keep" }],
          },
        }],
        next: "http://127.0.0.1/never-follow-this-url",
      });
    });

    const client = await createNocoDbTableClient({
      baseUrl: "http://93.184.216.34",
      baseId: "base-id",
      tableId: "table-id",
      apiKey: "test-api-key",
    });
    const response = await client.listRecords({
      where: "(Name,neq,Bob)",
      viewId: "view-id",
      limit: 2,
    });
    expect(offsets).toEqual(["0", "1"]);
    expect(response.list).toHaveLength(2);
    expect(response.list[0]).toEqual({
      Id: 1,
      Name: "Alice",
      Related: [{
        Id: "related-id",
        Name: "Bob",
        Payload: { id: 9, fields: { status: "nested" }, extra: true },
      }],
      Payload: { id: 7, fields: { status: "ok" }, extra: "keep" },
      Payloads: [{ id: 8, fields: { status: "ok" }, extra: "keep" }],
    });
    expect(response.pageInfo.totalRows).toBe(7);
    expect(response.pageInfo.isLastPage).toBe(false);
  });

  it("keeps handler relation updates additive for mixed and relation-only inputs", async () => {
    for (const baseId of [undefined, "base-id"]) {
      for (const relationOnly of [false, true]) {
        const writes: unknown[] = [];
        const errors: string[] = [];
        const recordIds = [1, "record-2"];
        replaceFetch(async (input, init) => {
          const url = new URL(getRequestUrl(input));
          if (url.pathname.includes("/meta/"))
            return Response.json(baseId ? {
              base_id: "base-id",
              fields: [{
                id: "relation-column",
                title: "Related",
                type: "LinkToAnotherRecord",
              }],
            } : {
              base_id: "base-id",
              columns: [{
                id: "relation-column",
                title: "Related",
                uidt: "LinkToAnotherRecord",
              }],
            });
          if (url.pathname.endsWith("/count"))
            return Response.json({ count: recordIds.length });
          if (init?.method === "GET")
            return Response.json({
              records: recordIds.map((id) => ({ id, fields: { Name: "Alice" } })),
              next: null,
            });
          writes.push({
            method: init?.method,
            path: url.pathname,
            body: await new Response(init?.body).json(),
          });
          return Response.json({ success: true });
        });

        const updates: { fieldName: string; value?: string }[] = [
          { fieldName: "Related", value: '["42","43"]' },
        ];
        if (!relationOnly) updates.push({ fieldName: "Name" });
        await updateExistingRecordHandler.server?.({
          credentials: { baseUrl: "http://93.184.216.34", apiKey: "test-api-key" },
          options: Object.assign(Object.create(null), {
            baseId,
            tableId: "table-id",
            filter: {
              comparisons: [{ input: "Name", operator: "Equal to", value: "Alice" }],
            },
            updates,
          }),
          variables: createVariablesStore(),
          logs: createLogsStore(errors),
          sessionStore: Object.create(null),
        });

        expect(errors).toEqual([]);
        expect(writes).toEqual([
          ...(relationOnly ? [] : recordIds.map((id) => ({
            method: "PATCH",
            path: "/api/v3/data/base-id/table-id/records",
            body: { id, fields: { Name: null } },
          }))),
          ...recordIds.map((id) => ({
            method: "POST",
            path: `/api/v3/data/base-id/table-id/links/relation-column/${id}`,
            body: [{ id: "42" }, { id: "43" }],
          })),
        ]);
      }
    }
  });

  it("bootstraps existing configurations and sends v3 update and link bodies", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    replaceFetch(async (input, init) => {
      urls.push(getRequestUrl(input));
      if (init?.method === "GET")
        return Response.json({ base_id: "base-id", columns: [] });
      bodies.push(await new Response(init?.body).json());
      return Response.json({ success: true });
    });

    const client = await createNocoDbTableClient({
      baseUrl: "http://93.184.216.34",
      tableId: "table-id",
      apiKey: "test-api-key",
    });
    await client.updateRecords(
      Array.from({ length: 11 }, (_, index) => ({
        Id: `record-${index}`,
        Name: null,
      })),
    );
    await client.linkRecords("relation-column", "record-0", ["42", 43]);
    expect(urls[0]).toBe(
      "http://93.184.216.34/api/v2/meta/tables/table-id",
    );
    expect(urls.slice(1, 12)).toEqual(
      Array(11).fill("http://93.184.216.34/api/v3/data/base-id/table-id/records"),
    );
    expect(bodies.slice(0, 11)).toEqual(
      Array.from({ length: 11 }, (_, index) => ({
        id: `record-${index}`,
        fields: { Name: null },
      })),
    );
    expect(urls[12]).toBe(
      "http://93.184.216.34/api/v3/data/base-id/table-id/links/relation-column/record-0",
    );
    expect(bodies[11]).toEqual([{ id: "42" }, { id: 43 }]);
  });
});

const executeCreateRecord = async (baseUrl: string) => {
  const errors: string[] = [];
  await createRecordHandler.server?.({
    credentials: { baseUrl, apiKey: "test-api-key" },
    options: Object.assign(Object.create(null), {
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
    options: Object.assign(Object.create(null), { tableId: "table-id" }),
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
    return Response.json({ base_id: "base-id", columns: [] });
  if (url.pathname.endsWith("/count")) return Response.json({ count: 1 });
  if (init?.method === "POST")
    return Response.json({ records: [{ id: 1, fields: {} }] });
  if (init?.method === "GET")
    return Response.json({ records: [{ id: 1, fields: {} }], next: null });
  return new Response(null, { status: 200 });
};
