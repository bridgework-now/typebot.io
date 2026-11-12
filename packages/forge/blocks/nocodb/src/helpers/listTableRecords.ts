import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse, RecordV3 } from "../types";
import { getTableMeta } from "./getTableMeta";
import { parseSearchParams } from "./parseSearchParams";

export const listTableRecords = async ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
  where,
  viewId,
  limit,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string;
  tableId: string;
  where: string | undefined;
  viewId: string | undefined;
  limit: number;
}): Promise<ListTableRecordsResponse> => {
  const tableUrl = `${baseUrl ?? defaultBaseUrl}/api/v3/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`;
  const headers = { "xc-token": apiKey };
  const records: RecordV3[] = [];

  // Cloud may serve fewer records than the requested page size.
  while (records.length < limit) {
    const page = await safeKy
      .get(`${tableUrl}/records`, {
        headers,
        searchParams: parseSearchParams({
          where,
          viewId,
          pageSize: limit,
          offset: records.length,
        }),
      })
      .json<{ records: RecordV3[]; next?: string | null }>();
    records.push(...page.records.slice(0, limit - records.length));
    if (!page.next || page.records.length === 0) break;
  }

  const { count } = await safeKy
    .get(`${tableUrl}/count`, {
      headers,
      searchParams: parseSearchParams({ where, viewId }),
    })
    .json<{ count: number }>();
  const tableMeta = await getTableMeta({ baseUrl, apiKey, baseId, tableId });
  const primaryField = tableMeta.fields.find((field) => field.type === "ID");
  const relationFields = tableMeta.fields.filter(
    (field) => field.type === "LinkToAnotherRecord" || field.type === "Links",
  );
  const list = records.map((record) => {
    const item = flattenRecord(record);
    if (primaryField) item[primaryField.title] = record.id;
    for (const field of relationFields) {
      const value = item[field.title];
      item[field.title] = Array.isArray(value)
        ? value.map(flattenLinkedRecord)
        : flattenLinkedRecord(value);
    }
    return item;
  });

  return {
    list,
    pageInfo: {
      totalRows: count,
      page: 1,
      pageSize: limit,
      isFirstPage: true,
      isLastPage: count <= list.length,
    },
  };
};

const flattenRecord = (record: RecordV3): ListTableRecordsResponse["list"][number] => ({
  ...record.id_fields,
  ...record.fields,
  Id: record.id,
});

// Restrict conversion to relation fields so JSON cells remain untouched.
const flattenLinkedRecord = (value: any): any => {
  if (
    value &&
    typeof value === "object" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    value.fields &&
    typeof value.fields === "object"
  ) return flattenRecord(value);
  return value;
};
