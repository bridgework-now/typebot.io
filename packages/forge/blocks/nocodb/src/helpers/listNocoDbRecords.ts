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

  const list: Record<string, any>[] = [];
  for (const record of records) {
    // V3 view results omit hidden fields. Read only the selected records
    // without the view, preserving its filtering, ordering, and pagination.
    const fullRecord = viewId
      ? await safeKy
          .get(`${tableUrl}/records/${encodeURIComponent(String(record.id))}`, {
            headers,
          })
          .json<NocoDbRecord>()
      : record;
    list.push({
      ...record.fields,
      ...fullRecord.fields,
      ...(primaryKeyName ? { [primaryKeyName]: record.id } : {}),
      ...record.id_fields,
      ...fullRecord.id_fields,
    });
  }

  return {
    list,
    recordIds: records.map((record) => record.id),
    pageInfo: { totalRows: count },
  };
};
