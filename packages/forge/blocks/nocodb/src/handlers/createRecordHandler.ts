import { createActionHandler } from "@typebot.io/forge";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { createRecord } from "../actions/createRecord";
import { createNocoDbTableClient } from "../helpers/createNocoDbTableClient";
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

      const tableClient = await createNocoDbTableClient({
        baseUrl,
        baseId,
        apiKey,
        tableId,
      });
      const response = await tableClient.createRecord(
        parseRecordsCreateBody(fields),
      );
      await linkRelationUpdatesIfAny({
        baseUrl,
        apiKey,
        tableId,
        tableClient,
        updates: fields,
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
