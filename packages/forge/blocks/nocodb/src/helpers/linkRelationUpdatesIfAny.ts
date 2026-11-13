import { isDefined } from "@typebot.io/lib/utils";
import { createNocoDbClient } from "./createNocoDbClient";

type Params = {
  baseUrl: string | undefined;
  baseId: string;
  apiKey: string;
  tableId: string;
  updates: { fieldName?: string; value?: string }[];
  recordIdsToUpdate: Array<string | number>;
};
export const linkRelationUpdatesIfAny = async ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
  updates,
  recordIdsToUpdate,
}: Params) => {
  const client = createNocoDbClient({ baseUrl, baseId, apiKey, tableId });
  const tableMeta = await client.getTableMeta();

  const relationUpdates = tableMeta.columns
    .filter(
      (col) => col.uidt === "LinkToAnotherRecord" || col.uidt === "Links",
    )
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
