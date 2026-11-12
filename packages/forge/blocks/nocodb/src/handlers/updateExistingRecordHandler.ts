import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { updateExistingRecord } from "../actions/updateExistingRecord";
import { defaultBaseUrl, defaultLimitForSearch } from "../constants";
import { convertFilterToWhereClause } from "../helpers/convertFilterToWhereClause";
import { excludeRelationFields } from "../helpers/excludeRelationFields";
import { getTableMeta } from "../helpers/getTableMeta";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { parseRecordsUpdateBody } from "../helpers/parseRecordsUpdateBody";
import { listTableRecords } from "../helpers/listTableRecords";

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
      if (!baseId) return logs.add("Base ID is required for NocoDB v3");
      if (!filter?.comparisons || filter.comparisons.length === 0)
        return logs.add("At least one filter is required");
      try {
        const listData = await listTableRecords({
          baseUrl,
          apiKey,
          baseId,
          tableId,
          where: convertFilterToWhereClause(filter),
          viewId,
          limit: defaultLimitForSearch,
        });

        const tableMeta = await getTableMeta({ baseUrl, apiKey, baseId, tableId });
        for (const { Id, ...fields } of parseRecordsUpdateBody(
          listData.list.map((item) => item.Id),
          updates,
        )) {
          // Relation writes use the additive linking endpoint below.
          const recordFields = excludeRelationFields(fields, tableMeta);
          if (Object.keys(recordFields).length === 0) continue;
          await safeKy.patch(
            `${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/records`,
            {
              headers: { "xc-token": apiKey },
              json: { id: Id, fields: recordFields },
            },
          );
        }

        await linkRelationUpdatesIfAny({
          baseUrl,
          apiKey,
          baseId,
          tableId,
          tableMeta,
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
