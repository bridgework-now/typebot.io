import { createActionHandler } from "@typebot.io/forge";
import { safeKy } from "@typebot.io/lib/ky";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { createRecord } from "../actions/createRecord";
import { defaultBaseUrl } from "../constants";
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
      if (!baseId) return logs.add("Base ID is required for NocoDB API v3");

      const response = await safeKy
        .post(`${baseUrl ?? defaultBaseUrl}/api/v3/data/${baseId}/${tableId}/records`, {
          headers: {
            "xc-token": apiKey,
          },
          json: { fields: parseRecordsCreateBody(fields) },
        })
        .json<{ records: { id: string | number }[] }>();
      const createdRecord = response.records[0];
      if (!createdRecord) throw new Error("NocoDB returned no created record");
      await linkRelationUpdatesIfAny({
        baseId,
        baseUrl,
        apiKey,
        tableId,
        updates: fields,
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
