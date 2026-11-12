import { afterEach, expect, it } from "bun:test";
import { convertFilterToWhereClause } from "./convertFilterToWhereClause";
import { excludeRelationFields } from "./excludeRelationFields";
import { listTableRecords } from "./listTableRecords";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("fills a capped page, retains totalRows, and adapts mapped values", async () => {
  const requestedUrls: URL[] = [];
  const jsonCell = { id: "json-id", fields: { untouched: true } };
  globalThis.fetch = Object.assign(async (
    input: Parameters<typeof fetch>[0],
  ) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requestedUrls.push(url);
    if (url.pathname.endsWith("/count")) return Response.json({ count: 5 });
    if (url.pathname.includes("/meta/")) return Response.json({ fields: [
      { id: "pk", title: "Record key", type: "ID" },
      { id: "relation", title: "Related", type: "LinkToAnotherRecord" },
    ] });
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({
      records: [offset, offset + 1].map((index) => ({
        id: `row-${index}`,
        fields: {
          Name: `Name ${index}`,
          JSON: jsonCell,
          Related: [{ id: "linked-id", fields: { Name: "Linked" } }],
        },
      })),
      next: "https://untrusted.example/ignored",
    });
  }, { preconnect: originalFetch.preconnect });

  const result = await listTableRecords({
    baseUrl: "http://93.184.216.34/prefix",
    apiKey: "test-api-key",
    baseId: "base-id",
    tableId: "table-id",
    where: "(Name,eq,Alice)",
    viewId: "view-id",
    limit: 3,
  });

  expect(result.list.map((record) => record.Id)).toEqual(["row-0", "row-1", "row-2"]);
  expect(result.pageInfo.totalRows).toBe(5);
  expect(result.list[0]?.["Record key"]).toBe("row-0");
  expect(result.list[0]?.JSON).toEqual(jsonCell);
  expect(result.list[0]?.Related).toEqual([{ Id: "linked-id", Name: "Linked" }]);
  const pages = requestedUrls.filter((url) => url.pathname.endsWith("/records"));
  expect(pages.map((url) => url.searchParams.get("offset"))).toEqual(["0", "2"]);
  expect(pages.every((url) => url.searchParams.get("pageSize") === "3")).toBe(true);
  expect(requestedUrls.every((url) =>
    url.origin === "http://93.184.216.34" && url.pathname.startsWith("/prefix/"),
  )).toBe(true);
  const countUrl = requestedUrls.find((url) => url.pathname.endsWith("/count"));
  expect(countUrl?.searchParams.get("where")).toBe("(Name,eq,Alice)");
  expect(countUrl?.searchParams.get("viewId")).toBe("view-id");
});

it("keeps relation fields out of replacement writes and preserves null updates", () => {
  expect(excludeRelationFields(
    { Name: null, Related: "42", Links: "43" },
    { fields: [
      { id: "relation", title: "Related", type: "LinkToAnotherRecord" },
      { id: "links", title: "Links", type: "Links" },
    ] },
  )).toEqual({ Name: null });
});

it("uses the documented v3 inequality operator", () => {
  expect(convertFilterToWhereClause({ comparisons: [{
    input: "Name", operator: "Not equal", value: "Alice",
  }] })).toBe("(Name,neq,Alice)");
});
