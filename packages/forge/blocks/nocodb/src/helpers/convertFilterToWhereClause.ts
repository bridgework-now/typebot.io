// See `where`: https://nocodb.com/docs/apis/filtering#v3-where-query-parameter
// Example: (colName,eq,colValue)~or(colName2,gt,colValue2)

import { isEmpty } from "@typebot.io/lib/utils";

export const convertFilterToWhereClause = (
  filter:
    | {
        comparisons: {
          input?: string;
          operator?: string;
          value?: string;
        }[];
        joiner?: "AND" | "OR";
      }
    | undefined,
): string | undefined => {
  if (!filter || !filter.comparisons || filter.comparisons.length === 0) return;

  const where = filter.comparisons
    .map((comparison) => {
      const field = JSON.stringify(comparison.input ?? "");
      const value = JSON.stringify(comparison.value ?? "");
      switch (comparison.operator) {
        case "Not equal":
          return `(${field},neq,${value})`;
        case "Contains":
          return `(${field},like,${JSON.stringify(`%${comparison.value ?? ""}%`)})`;
        case "Greater than":
          return `(${field},gt,${value})`;
        case "Less than":
          return `(${field},lt,${value})`;
        case "Is set":
          return `(${field},isnot,null)`;
        case "Is empty":
          return `(${field},is,null)`;
        case "Starts with":
          return `(${field},like,${JSON.stringify(`${comparison.value ?? ""}%`)})`;
        case "Ends with":
          return `(${field},like,${JSON.stringify(`%${comparison.value ?? ""}`)})`;
        default:
          return `(${field},eq,${value})`;
      }
    })
    .filter(Boolean)
    .join(`~${filter.joiner === "OR" ? "or" : "and"}`);

  if (isEmpty(where)) return;
  return where;
};
