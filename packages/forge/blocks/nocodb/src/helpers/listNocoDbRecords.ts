import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl, defaultLimitForSearch } from "../constants";
import type { ListTableRecordsResponse, NocoDbRecord } from "../types";
import { getNocoDbTableIdentity } from "./getNocoDbTableIdentity";
import { parseSearchParams } from "./parseSearchParams";

export const listNocoDbRecords = async ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
  where,
  viewId,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string | undefined;
  tableId: string;
  where: string | undefined;
  viewId: string | undefined;
}) => {
  const identity = await getNocoDbTableIdentity({ baseUrl, apiKey, tableId });
  const resolvedBaseId = baseId ?? identity.baseId;
  const primaryKeyName = identity.primaryKeyName;
  if (!primaryKeyName)
    throw new Error("NocoDB table metadata must identify one primary-key column");
  const tableUrl = `${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(resolvedBaseId)}/${encodeURIComponent(tableId)}`;
  const headers = { "xc-token": apiKey };
  const searchParams = parseSearchParams({ where, viewId });
  const { count } = await safeKy
    .get(`${tableUrl}/count`, { headers, searchParams })
    .json<{ count: number }>();
  const records: NocoDbRecord[] = [];

  for (let page = 1; records.length < defaultLimitForSearch; page++) {
    const response = await safeKy
      .get(`${tableUrl}/records`, {
        headers,
        searchParams: {
          ...searchParams,
          page: page.toString(),
          pageSize: defaultLimitForSearch.toString(),
        },
      })
      .json<ListTableRecordsResponse>();
    records.push(
      ...response.records.slice(0, defaultLimitForSearch - records.length),
    );
    if (!response.next || response.records.length === 0) break;
  }

  return {
    list: records.map((record) => ({
      ...record.fields,
      [primaryKeyName]: record.id,
    })),
    recordIds: records.map((record) => record.id),
    pageInfo: { totalRows: count },
  };
};
