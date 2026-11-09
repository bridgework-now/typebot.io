import { describe, expect, it } from "bun:test";
import { convertFilterToWhereClause } from "./convertFilterToWhereClause";
import { parseRecordsUpdateBody } from "./parseRecordsUpdateBody";

describe("NocoDB v3 update payloads", () => {
  it("keeps identifiers separate from fields, including a field named Id", () => {
    expect(
      parseRecordsUpdateBody([7, "external-key"], [
        { fieldName: "Id", value: "custom value" },
        { fieldName: "Name", value: "" },
        { fieldName: "Optional" },
        { value: "ignored" },
      ]),
    ).toEqual([
      {
        id: 7,
        fields: { Id: "custom value", Name: "", Optional: null },
      },
      {
        id: "external-key",
        fields: { Id: "custom value", Name: "", Optional: null },
      },
    ]);
  });

  it("does not fabricate records for an empty match set", () => {
    expect(parseRecordsUpdateBody([], [{ fieldName: "Name", value: "Bob" }])).toEqual([]);
  });

  it("uses the documented inequality operator and retains filter joins", () => {
    expect(
      convertFilterToWhereClause({
        comparisons: [
          { input: "Name", operator: "Not equal", value: "Alice" },
          { input: "Age", operator: "Greater than", value: "18" },
        ],
        joiner: "OR",
      }),
    ).toBe("(Name,neq,Alice)~or(Age,gt,18)");
  });
});
