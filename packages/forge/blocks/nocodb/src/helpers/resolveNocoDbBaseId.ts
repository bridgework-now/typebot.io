import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";

export const resolveNocoDbBaseId = async ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
}: {
  baseUrl: string | undefined;
  baseId: string | undefined;
  apiKey: string;
  tableId: string;
}): Promise<string> => {
  if (baseId) return baseId;

  // Saved actions predate Base ID. Keep v2 only for table-to-base discovery.
  // https://nocodb.com/apis/v2/meta
  const table = await safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v2/meta/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<{ base_id?: unknown }>();

  if (typeof table.base_id !== "string" || table.base_id.length === 0)
    throw new Error(
      "Could not resolve NocoDB Base ID. Enter the Base ID in the action settings.",
    );

  return table.base_id;
};
