import { isDefined } from "@typebot.io/lib/utils";
import { createNocoDbClient } from "./createNocoDbClient";

type Params = {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string | undefined;
  tableId: string;
  updates: { fieldName?: string; value?: string }[];
  recordIdsToUpdate: (string | number)[];
};
export const linkRelationUpdatesIfAny = async ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
  updates,
  recordIdsToUpdate,
}: Params) => {
  const client = createNocoDbClient({ baseUrl, apiKey, baseId, tableId });
  const tableMeta = await client.getTable();

  const relationUpdates = tableMeta.fields
    .filter(
      (col) => col.type === "LinkToAnotherRecord" || col.type === "Links",
    )
    .map((col) => ({
      id: col.id,
      value: transformValToArray(
        updates.find(
          (update) =>
            update.fieldName === col.title || update.fieldName === col.id,
        )?.value,
      ),
    }))
    .filter((update) => isDefined(update.value));

  for (const relationUpdate of relationUpdates) {
    for (const record of recordIdsToUpdate) {
      await client.link(relationUpdate.id, record, relationUpdate.value!);
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
