import { safeKy } from "@typebot.io/lib/ky";
import { isDefined } from "@typebot.io/lib/utils";
import { defaultBaseUrl } from "../constants";
import type { TableMetaResponse } from "../types";
import { getNocoDbTableMeta } from "./getNocoDbTableMeta";

type Params = {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string;
  tableId: string;
  tableMeta?: TableMetaResponse;
  updates: { fieldName?: string; value?: string }[];
  recordIdsToUpdate: (string | number)[];
};
export const linkRelationUpdatesIfAny = async ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
  tableMeta: suppliedTableMeta,
  updates,
  recordIdsToUpdate,
}: Params) => {
  const tableMeta = suppliedTableMeta ?? await getNocoDbTableMeta({
    baseUrl,
    apiKey,
    baseId,
    tableId,
  });

  const relationUpdates = tableMeta.fields
    .filter((col) => ["LinkToAnotherRecord", "Links"].includes(col.type))
    .map((col) => ({
      id: col.id,
      value: transformValToArray(
        updates.find((update) => update.fieldName === col.title)?.value,
      ),
    }))
    .filter((update) => isDefined(update.value));

  for (const relationUpdate of relationUpdates) {
    for (const record of recordIdsToUpdate) {
      await safeKy
        .post(
          `${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/links/${encodeURIComponent(relationUpdate.id)}/${encodeURIComponent(String(record))}`,
          {
            headers: {
              "xc-token": apiKey,
            },
            json: relationUpdate.value!.map((id) => ({ id })),
          },
        )
        .json();
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
