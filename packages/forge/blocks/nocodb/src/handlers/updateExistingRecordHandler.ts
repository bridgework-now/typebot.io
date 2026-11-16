import { createActionHandler } from "@typebot.io/forge";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { updateExistingRecord } from "../actions/updateExistingRecord";
import { defaultLimitForSearch } from "../constants";
import { createNocoDbClient } from "../helpers/createNocoDbClient";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { parseRecordsUpdateBody } from "../helpers/parseRecordsUpdateBody";
import { resolveNocoDbBaseId } from "../helpers/resolveNocoDbBaseId";

export const updateExistingRecordHandler = createActionHandler(
  updateExistingRecord,
  {
    server: async ({
      credentials: { baseUrl, apiKey },
      options: { baseId: configuredBaseId, tableId, filter, viewId, updates },
      logs,
    }) => {
      if (!apiKey) return logs.add("API key is required");
      if (!updates) return logs.add("At least one update is required");
      if (!tableId) return logs.add("Table ID is required");
      if (!filter?.comparisons || filter.comparisons.length === 0)
        return logs.add("At least one filter is required");
      try {
        const baseId = await resolveNocoDbBaseId({
          baseUrl,
          baseId: configuredBaseId,
          apiKey,
          tableId,
        });
        const client = createNocoDbClient({ baseUrl, baseId, apiKey, tableId });
        const listData = await client.listRecords({
          where: convertFilterToWhereClause(filter),
          viewId,
          limit: defaultLimitForSearch,
        });

        await client.updateRecords(
          parseRecordsUpdateBody(
            listData.list.map((item) => item.Id),
            updates,
          ),
        );

        await linkRelationUpdatesIfAny({
          baseUrl,
          baseId,
          apiKey,
          tableId,
          updates,
          recordIdsToUpdate: listData.list.map((item) => item.Id),
        });
      } catch (error) {
        logs.add(
          await parseUnknownError({
            err: error,
            context: "While updating NocoDB existing record",
          }),
        );
      }
    },
  },
);
