import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { updateExistingRecord } from "../actions/updateExistingRecord";
import { defaultBaseUrl, defaultLimitForSearch } from "../constants";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { parseRecordsUpdateBody } from "../helpers/parseRecordsUpdateBody";
import { parseSearchParams } from "../helpers/parseSearchParams";
import { listAllRecords } from "../helpers/listAllRecords";

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
      if (!baseId) return logs.add("Base ID is required for NocoDB API v3");
      if (!filter?.comparisons || filter.comparisons.length === 0)
        return logs.add("At least one filter is required");
      try {
        const records = await listAllRecords(
          `${baseUrl ?? defaultBaseUrl}/api/v3/data/${baseId}/${tableId}/records`,
          apiKey,
          parseSearchParams({
            where: convertFilterToWhereClause(filter),
            viewId,
            pageSize: defaultLimitForSearch,
          }),
        );

        const recordIdsToUpdate = records.map((record) => record.id);
        if (recordIdsToUpdate.length === 0) return;

        const updateBatchSize = 10;
        for (
          let recordIndex = 0;
          recordIndex < recordIdsToUpdate.length;
          recordIndex += updateBatchSize
        ) {
          await safeKy.patch(
            `${baseUrl ?? defaultBaseUrl}/api/v3/data/${baseId}/${tableId}/records`,
            {
              headers: {
                "xc-token": apiKey,
              },
              json: parseRecordsUpdateBody(
                recordIdsToUpdate.slice(
                  recordIndex,
                  recordIndex + updateBatchSize,
                ),
                updates,
              ),
            },
          );
        }

        await linkRelationUpdatesIfAny({
          baseId,
          baseUrl,
          apiKey,
          tableId,
          updates,
          recordIdsToUpdate,
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
