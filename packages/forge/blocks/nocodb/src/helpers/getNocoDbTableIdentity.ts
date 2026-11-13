import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";

// The documented v3 table schema does not identify primary-key columns or
// support discovering a base from a table ID alone. Keep this compatibility
// lookup until those capabilities have a documented replacement.
// https://raw.githubusercontent.com/nocodb/noco-apis-doc/main/meta-apis-v2/swagger-v2.json
export const getNocoDbTableIdentity = async ({
  baseUrl,
  apiKey,
  tableId,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  tableId: string;
}) => {
  const table = await safeKy
    .get(
      `${baseUrl ?? defaultBaseUrl}/api/v2/meta/tables/${encodeURIComponent(tableId)}`,
      { headers: { "xc-token": apiKey } },
    )
    .json<{
      base_id: string;
      columns: { title: string; pk?: boolean | number }[];
    }>();
  if (!table.base_id)
    throw new Error("NocoDB table metadata did not include a base ID");

  const primaryKeyColumns = table.columns.filter(
    (column) => column.pk === true || column.pk === 1,
  );
  return {
    baseId: table.base_id,
    primaryKeyName:
      primaryKeyColumns.length === 1 ? primaryKeyColumns[0]?.title : undefined,
  };
};
