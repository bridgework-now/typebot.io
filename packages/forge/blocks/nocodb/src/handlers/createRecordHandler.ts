import { createActionHandler } from "@typebot.io/forge";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { createRecord } from "../actions/createRecord";
import { createNocoDbClient } from "../helpers/createNocoDbClient";
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

      const response = await createNocoDbClient({
        baseUrl,
        baseId,
        tableId,
        apiKey,
      }).create(parseRecordsCreateBody(fields));
      await linkRelationUpdatesIfAny({
        baseUrl,
        apiKey,
        baseId,
        tableId,
        updates: fields.map(({ key, value }) => ({ fieldName: key, value })),
        recordIdsToUpdate: [response.Id],
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
