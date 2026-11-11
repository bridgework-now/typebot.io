import { isDefined } from "@typebot.io/lib/utils";
import { createNocoDbTableClient } from "./createNocoDbTableClient";

type Params = {
  baseUrl: string | undefined;
  apiKey: string;
  tableId: string;
  updates: { fieldName?: string; value?: string }[];
  recordIdsToUpdate: (string | number)[];
  baseId?: string;
  tableClient?: Awaited<ReturnType<typeof createNocoDbTableClient>>;
};
export const linkRelationUpdatesIfAny = async ({
  baseUrl,
  apiKey,
  tableId,
  updates,
  recordIdsToUpdate,
  baseId,
  tableClient,
}: Params) => {
  const client =
    tableClient ??
    (await createNocoDbTableClient({ baseUrl, baseId, apiKey, tableId }));
  const { tableMeta } = client;

  const relationUpdates = tableMeta.columns
    .filter((col) => col.uidt === "LinkToAnotherRecord")
    .map((col) => ({
      id: col.id,
      value: transformValToArray(
        updates.find((update) => update.fieldName === col.title)?.value,
      ),
    }))
    .filter((update) => isDefined(update.value));

  for (const relationUpdate of relationUpdates) {
    for (const record of recordIdsToUpdate) {
      await client.linkRecords(
        relationUpdate.id,
        record,
        relationUpdate.value!,
      );
    }
  }
};

const transformValToArray = (val: string | undefined): string[] | undefined => {
  if (!val) return;
  if (val.startsWith("[") && val.endsWith("]")) {
    try {
      return JSON.parse(val);
    } catch (error) {
      console.error("Failed to parse JSON value:", val, error);
      return [val]; // Fallback to treating as single value
    }
  }
  return [val];
};
