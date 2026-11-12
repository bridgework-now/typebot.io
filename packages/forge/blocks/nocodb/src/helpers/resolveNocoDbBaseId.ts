import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";

export const resolveNocoDbBaseId = async ({
  baseUrl,
  baseId,
  tableId,
  apiKey,
}: {
  baseUrl?: string;
  baseId?: string;
  tableId: string;
  apiKey: string;
}) => {
  if (baseId) return baseId;

  // Saved actions contain only tableId. Bootstrap through the documented
  // table-only metadata route until their Base ID is configured explicitly.
  const table = await safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v2/meta/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<{ base_id?: unknown }>();

  if (typeof table.base_id !== "string" || !table.base_id)
    throw new Error("Could not resolve NocoDB base ID; configure Base ID explicitly");

  return table.base_id;
};
