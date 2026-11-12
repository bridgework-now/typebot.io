import type { TableMetaResponse } from "../types";

export const excludeRelationFields = (
  fields: Record<string, any>,
  tableMeta: TableMetaResponse,
) => {
  const relationNames = new Set(
    tableMeta.fields
      .filter((field) =>
        field.type === "LinkToAnotherRecord" || field.type === "Links",
      )
      .map((field) => field.title),
  );
  return Object.fromEntries(
    Object.entries(fields).filter(([name]) => !relationNames.has(name)),
  );
};
