import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { TableMetaResponse } from "../types";
import { getNocoDbTableIdentity } from "./getNocoDbTableIdentity";

export const getNocoDbTableMeta = async ({
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
  const resolvedBaseId =
    baseId ??
    (await getNocoDbTableIdentity({ baseUrl, apiKey, tableId })).baseId;
  const tableMeta = await safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v3/meta/bases/${encodeURIComponent(resolvedBaseId)}/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<TableMetaResponse>();
  return { ...tableMeta, base_id: resolvedBaseId };
};
