import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { createRecord } from "../actions/createRecord";
import { defaultBaseUrl } from "../constants";
import { excludeRelationFields } from "../helpers/excludeRelationFields";
import { getTableMeta } from "../helpers/getTableMeta";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { parseRecordsCreateBody } from "../helpers/parseRecordCreateBody";

export const createRecordHandler = createActionHandler(createRecord, {
  server: async ({
    credentials: { baseUrl, apiKey },
    options: { baseId, tableId, fields },
    logs,
  }) => {
    try {
      if (!fields || fields.length === 0) return;
      if (!apiKey) return logs.add("API key is required");
      if (!tableId) return logs.add("Table ID is required");
      if (!baseId) return logs.add("Base ID is required for NocoDB v3");
      const tableMeta = await getTableMeta({ baseUrl, apiKey, baseId, tableId });

      const response = await safeKy
        .post(`${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/records`, {
          headers: {
            "xc-token": apiKey,
          },
          json: {
            fields: excludeRelationFields(parseRecordsCreateBody(fields), tableMeta),
          },
        })
        .json<{ records: { id: string | number }[] }>();
      await linkRelationUpdatesIfAny({
        baseUrl,
        apiKey,
        baseId,
        tableId,
        tableMeta,
        updates: fields.map(({ key, value }) => ({ fieldName: key, value })),
        recordIdsToUpdate: response.records.map((record) => record.id),
      });
    } catch (error) {
      logs.add(
        await parseUnknownError({
          err: error,
          context: "While creating NocoDB record",
        }),
      );
    }
  },
});
