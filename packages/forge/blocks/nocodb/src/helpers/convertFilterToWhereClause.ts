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
  version: "v2" | "v3" = "v3",
): string | undefined => {
  if (!filter || !filter.comparisons || filter.comparisons.length === 0) return;

  const where = filter.comparisons
    .map((comparison) => {
      // Preserve the original filter syntax for saved API v2 actions.
      if (version === "v2") {
        switch (comparison.operator) {
          case "Not equal":
            return `(${comparison.input},ne,${comparison.value})`;
          case "Contains":
            return `(${comparison.input},like,%${comparison.value}%)`;
          case "Greater than":
            return `(${comparison.input},gt,${comparison.value})`;
          case "Less than":
            return `(${comparison.input},lt,${comparison.value})`;
          case "Is set":
            return `(${comparison.input},isnot,null)`;
          case "Is empty":
            return `(${comparison.input},is,null)`;
          case "Starts with":
            return `(${comparison.input},like,${comparison.value}%)`;
          case "Ends with":
            return `(${comparison.input},like,%${comparison.value})`;
          default:
            return `(${comparison.input},eq,${comparison.value})`;
        }
      }
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
