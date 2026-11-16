import { afterEach, describe, expect, it } from "bun:test";
import { convertFilterToWhereClause } from "./convertFilterToWhereClause";
import { createNocoDbClient } from "./createNocoDbClient";

const originalFetch = globalThis.fetch;
const baseUrl = "http://93.184.216.34";
const credentials = { baseUrl, baseId: "base-id", apiKey: "test-api-key" };
const recordsPath = "/api/v3/data/base-id/table-id/records";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NocoDB v3 migration", () => {
  it("requires a base ID before making requests", () => {
    expect(() =>
      createNocoDbClient({ apiKey: "test-api-key", tableId: "table-id" }),
    ).toThrow("Base ID is required");
  });

  it("wraps create fields and retains the returned record ID", async () => {
    replaceFetch(async (request) => {
      expect(request.url).toBe(`${baseUrl}${recordsPath}`);
      expect(request.headers.get("xc-token")).toBe("test-api-key");
      expect(await request.json()).toEqual({ fields: { Name: "Alice" } });
      return Response.json({ records: [{ id: "external-key", fields: {} }] });
    });
    const result = await createClient().createRecord({ Name: "Alice" });
    expect(result).toEqual({ Id: "external-key" });
  });

  it("retains view selection, hidden fields, total count and the caller limit", async () => {
    const requestedUrls: URL[] = [];
    replaceFetch(async (request) => {
      const url = new URL(request.url);
      requestedUrls.push(url);
      if (url.pathname.includes("/meta/"))
        return Response.json({
          fields: [
            { id: "relation-id", title: "Related", type: "LinkToAnotherRecord" },
          ],
        });
      if (url.pathname.endsWith("/count")) {
        expect(url.searchParams.get("where")).toBe("(Name,eq,Alice)");
        expect(url.searchParams.get("viewId")).toBe("view-id");
        return Response.json({ count: 5 });
      }
      if (url.pathname === recordsPath) {
        expect(url.searchParams.get("viewId")).toBe("view-id");
        expect(url.searchParams.get("where")).toBe("(Name,eq,Alice)");
        expect(url.searchParams.get("pageSize")).toBe("2");
        const page = Number(url.searchParams.get("page"));
        return Response.json({
          records: [{ id: page, fields: { Name: "Alice" } }],
          next: "https://different-host.example/records?page=2",
        });
      }
      expect(url.searchParams.has("viewId")).toBe(false);
      const id = Number(url.pathname.split("/").at(-1));
      return Response.json({
        record: {
          id,
          id_fields: { PrimaryKey: id },
          fields: {
            Name: "Alice",
            Hidden: "preserved",
            Related: [{ id: 42, fields: { Name: "Bob" } }],
          },
        },
      });
    });
    const result = await createClient().listRecords({
      where: "(Name,eq,Alice)",
      viewId: "view-id",
      limit: 2,
    });
    expect(result.pageInfo.totalRows).toBe(5);
    expect(result.list).toEqual(
      [1, 2].map((id) => ({
        Id: id,
        PrimaryKey: id,
        Name: "Alice",
        Hidden: "preserved",
        Related: [{ Id: 42, Name: "Bob" }],
      })),
    );
    expect(requestedUrls.every((url) => url.origin === baseUrl)).toBe(true);
    expect(
      requestedUrls.filter((url) => url.pathname === recordsPath).length,
    ).toBe(2);
  });

  it("keeps link additions out of PATCH and handles more than ten updates", async () => {
    const patches: unknown[] = [];
    replaceFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.includes("/meta/"))
        return Response.json({
          fields: [{ id: "relation-id", title: "Related", type: "Links" }],
        });
      if (request.method === "PATCH") {
        patches.push(await request.json());
        return Response.json({ records: [] });
      }
      expect(request.method).toBe("POST");
      expect(url.pathname).toBe(
        "/api/v3/data/base-id/table-id/links/relation-id/external-key",
      );
      expect(await request.json()).toEqual([{ id: "42" }]);
      return Response.json({ success: true });
    });
    const client = createClient();
    await client.updateRecords(
      Array.from({ length: 11 }, (_, index) => ({
        Id: index + 1,
        Name: "Bob",
        Related: "42",
        Cleared: null,
      })),
    );
    expect(patches).toEqual(
      Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        fields: { Name: "Bob", Cleared: null },
      })),
    );
    await client.linkRecords("relation-id", "external-key", ["42"]);
  });

  it("uses the documented v3 inequality operator", () => {
    expect(
      convertFilterToWhereClause({
        comparisons: [{ input: "Name", operator: "Not equal", value: "Alice" }],
      }),
    ).toBe("(Name,neq,Alice)");
  });
});

const createClient = () =>
  createNocoDbClient({ ...credentials, tableId: "table-id" });

const replaceFetch = (implementation: (request: Request) => Promise<Response>) => {
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      implementation(new Request(input, init)),
    { preconnect: originalFetch.preconnect },
  );
};
