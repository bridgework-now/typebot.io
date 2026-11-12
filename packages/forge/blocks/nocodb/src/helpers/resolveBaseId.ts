import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";

export const resolveBaseId = async ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string | undefined;
  tableId: string;
}) => {
  if (baseId) return baseId;

  // Saved actions predate baseId. Use v2 only to discover their base.
  const tableMeta = await safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v2/meta/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<{ base_id?: unknown }>();

  if (typeof tableMeta.base_id !== "string" || !tableMeta.base_id.trim())
    throw new Error("Unable to resolve NocoDB Base ID from table metadata");

  return tableMeta.base_id;
};
