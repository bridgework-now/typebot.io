import { createActionHandler } from "@typebot.io/forge";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { isDefined, isNotDefined } from "@typebot.io/lib/utils";
import { searchRecords } from "../actions/searchRecords";
import { defaultLimitForSearch } from "../constants";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { createNocoDbTableClient } from "../helpers/createNocoDbTableClient";

export const searchRecordsHandler = createActionHandler(searchRecords, {
  server: async ({
    credentials: { baseUrl, apiKey },
    options: { baseId, tableId, responseMapping, filter, returnType, viewId },
    variables,
    logs,
  }) => {
    if (!apiKey) return logs.add("API key is required");
    if (!tableId) return logs.add("Table ID is required");
    try {
      const tableClient = await createNocoDbTableClient({
        baseUrl,
        baseId,
        apiKey,
        tableId,
      });
      const data = await tableClient.listRecords({
        where: convertFilterToWhereClause(filter),
        viewId,
        limit: defaultLimitForSearch,
      });

      let filterIndex: number | undefined;

      if (returnType && returnType !== "All") {
        const total = data.pageInfo.totalRows;
        if (returnType === "First") {
          filterIndex = 0;
        } else if (returnType === "Last") {
          filterIndex = total - 1;
        } else if (returnType === "Random") {
          filterIndex = Math.floor(Math.random() * total);
        }
      }

      const filteredList =
        isDefined(filterIndex) && data.list[filterIndex]
          ? [data.list[filterIndex]]
          : data.list;

      if (filteredList.length === 0)
        return logs.add({
          status: "info",
          description: `Couldn't find any rows matching the filter`,
          details: JSON.stringify(filter, null, 2),
        });

      responseMapping?.forEach((mapping) => {
        if (!mapping.fieldName || !mapping.variableId) return;
        if (isNotDefined(filteredList[0]![mapping.fieldName])) {
          logs.add(`Field ${mapping.fieldName} does not exist in the table`);
          return;
        }

        const items = filteredList.map(
          (item) => item![mapping.fieldName as string],
        );

        variables.set([
          {
            id: mapping.variableId,
            value: items.length === 1 ? items[0] : items,
          },
        ]);
      });
    } catch (error) {
      logs.add(
        await parseUnknownError({
          err: error,
          context: "While searching NocoDB records",
        }),
      );
    }
  },
});
