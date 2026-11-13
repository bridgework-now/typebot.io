import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { updateExistingRecord } from "../actions/updateExistingRecord";
import { defaultBaseUrl } from "../constants";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { getNocoDbTableMeta } from "../helpers/getNocoDbTableMeta";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { listNocoDbRecords } from "../helpers/listNocoDbRecords";
import { parseRecordsUpdateBody } from "../helpers/parseRecordsUpdateBody";

export const updateExistingRecordHandler = createActionHandler(
  updateExistingRecord,
  {
    server: async ({
      credentials: { baseUrl, apiKey },
      options: { baseId, tableId, filter, viewId, updates },
      logs,
    }) => {
      if (!apiKey) return logs.add("API key is required");
      if (!updates) return logs.add("At least one update is required");
      if (!tableId) return logs.add("Table ID is required");
      if (!filter?.comparisons || filter.comparisons.length === 0)
        return logs.add("At least one filter is required");
      try {
        const listData = await listNocoDbRecords({
          baseUrl,
          apiKey,
          baseId,
          tableId,
          where: convertFilterToWhereClause(filter),
          viewId,
        });
        if (listData.recordIds.length === 0) return;
        const tableMeta = await getNocoDbTableMeta({
          baseUrl,
          apiKey,
          baseId,
          tableId,
        });
        const relationFieldNames = new Set(
          tableMeta.fields
            .filter((field) =>
              ["LinkToAnotherRecord", "Links"].includes(field.type),
            )
            .map((field) => field.title),
        );
        const fieldUpdates = updates.filter(
          (update) => !relationFieldNames.has(update.fieldName ?? ""),
        );

        if (fieldUpdates.some((update) => update.fieldName)) {
          // Single-record writes also work when a deployment lowers its bulk cap.
          for (const recordId of listData.recordIds) {
            await safeKy.patch(
              `${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(tableMeta.base_id)}/${encodeURIComponent(tableId)}/records`,
              {
                headers: {
                  "xc-token": apiKey,
                },
                json: parseRecordsUpdateBody([recordId], fieldUpdates),
              },
            );
          }
        }

        await linkRelationUpdatesIfAny({
          baseUrl,
          apiKey,
          baseId: tableMeta.base_id,
          tableId,
          tableMeta,
          updates,
          recordIdsToUpdate: listData.recordIds,
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
