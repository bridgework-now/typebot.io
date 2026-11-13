import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { createRecord } from "../actions/createRecord";
import { defaultBaseUrl } from "../constants";
import { getNocoDbTableMeta } from "../helpers/getNocoDbTableMeta";
import { linkRelationUpdatesIfAny } from "../helpers/linkRelationUpdatesIfAny";
import { parseRecordsCreateBody } from "../helpers/parseRecordCreateBody";
import type { NocoDbRecord } from "../types";

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

      const response = await safeKy
        .post(`${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(tableMeta.base_id)}/${encodeURIComponent(tableId)}/records`, {
          headers: {
            "xc-token": apiKey,
          },
          json: {
            fields: parseRecordsCreateBody(
              fields.filter((field) => !relationFieldNames.has(field.key ?? "")),
            ),
          },
        })
        .json<{ records: NocoDbRecord[] }>();
      const createdRecord = response.records[0];
      if (!createdRecord) throw new Error("NocoDB returned no created record");
      await linkRelationUpdatesIfAny({
        baseUrl,
        apiKey,
        baseId: tableMeta.base_id,
        tableId,
        tableMeta,
        updates: fields.map(({ key, value }) => ({ fieldName: key, value })),
        recordIdsToUpdate: [createdRecord.id],
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
