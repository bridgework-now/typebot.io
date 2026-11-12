import { afterEach, expect, it } from "bun:test";
import { createNocoDbClient } from "./createNocoDbClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("requires the base ID before making requests", () => {
  expect(() =>
    createNocoDbClient({ tableId: "table", apiKey: "test-token" }),
  ).toThrow("Base ID is required");
});

it("preserves the custom host and token and wraps writes without replacing links", async () => {
  const writes: { method?: string; body: unknown }[] = [];
  replaceFetch(async (url, init) => {
    expect(url.origin).toBe("http://93.184.216.34");
    expect(new Headers(init?.headers).get("xc-token")).toBe("test-token");
    if (url.pathname.includes("/meta/")) {
      return Response.json({
        fields: [{ id: "relation", title: "Related", type: "Links" }],
      });
    }
    expect(url.pathname).toBe("/api/v3/data/base/table/records");
    writes.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
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
