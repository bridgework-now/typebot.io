import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { TableMetaResponse } from "../types";

export const getTableMeta = ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string;
  tableId: string;
}) =>
  safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v3/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<TableMetaResponse>();
