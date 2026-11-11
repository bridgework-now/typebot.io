import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse } from "../types";
import { parseSearchParams } from "./parseSearchParams";

export const createNocoDbTableClient = async ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
}: {
  baseUrl: string | undefined;
  baseId?: string;
  apiKey: string;
  tableId: string;
}) => {
  const origin = baseUrl ?? defaultBaseUrl;
  const headers = { "xc-token": apiKey };
  const encodedTableId = encodeURIComponent(tableId);
  const tableMeta = baseId
    ? await safeKy
        .get(
          `${origin}/api/v3/meta/bases/${encodeURIComponent(baseId)}/tables/${encodedTableId}`,
          { headers },
        )
        .json<{
          base_id: string;
          fields: { id: string; title: string; type: string }[];
        }>()
        .then((table) => ({
          base_id: table.base_id,
          columns: table.fields.map((field) => ({
            id: field.id,
            title: field.title,
            uidt: field.type,
          })),
        }))
    : await safeKy
        // Existing configurations only contain a table ID. Retain this lookup
        // until their base IDs are supplied; v3 metadata requires both IDs.
        .get(`${origin}/api/v2/meta/tables/${encodedTableId}`, { headers })
        .json<{
          base_id: string;
          columns: { id: string; title: string; uidt: string }[];
        }>();

  const resolvedBaseId = baseId || tableMeta.base_id;
  if (!resolvedBaseId)
    throw new Error("Base ID is required. Set it in the NocoDB action options.");

  const dataUrl = `${origin}/api/v3/data/${encodeURIComponent(resolvedBaseId)}/${encodedTableId}`;
  const recordsUrl = `${dataUrl}/records`;
  const relationFieldNames = new Set(
    tableMeta.columns
      .filter((column) => column.uidt === "LinkToAnotherRecord")
      .map((column) => column.title),
  );

  return {
    tableMeta,
    createRecord: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(recordsUrl, { headers, json: { fields } })
        .json<{ records: NocoDbRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB returned no created record");
      return { Id: record.id };
    },
    listRecords: async ({
      where,
      viewId,
      limit,
    }: {
      where?: string;
      viewId?: string;
      limit: number;
    }): Promise<ListTableRecordsResponse> => {
      const list: ListTableRecordsResponse["list"] = [];
      let hasNextPage = true;
      while (hasNextPage && list.length < limit) {
        const response = await safeKy
          .get(recordsUrl, {
            headers,
            searchParams: parseSearchParams({
              where,
              viewId,
              limit: limit - list.length,
              offset: list.length,
            }),
          })
          .json<{ records: NocoDbRecord[]; next?: string | null }>();
        const records = response.records.slice(0, limit - list.length);
        list.push(
          ...records.map((record) => normalizeRecord(record, relationFieldNames)),
        );
        // Use the pagination flag, never a provider-supplied URL, to retain
        // the configured origin and safeKy validation on every request.
        hasNextPage = Boolean(response.next) && records.length > 0;
      }

      const { count } = await safeKy
        .get(`${dataUrl}/count`, {
          headers,
          searchParams: parseSearchParams({ where, viewId }),
        })
        .json<{ count: number }>();

      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: limit,
          isFirstPage: true,
          isLastPage: list.length >= count,
        },
      };
    },
    updateRecords: async (records: Record<string, any>[]) => {
      // Single-record requests also work when a deployment lowers its bulk cap.
      for (const { Id, ...recordFields } of records) {
        // Relations are linked separately to preserve existing links.
        const fields = Object.fromEntries(
          Object.entries(recordFields).filter(
            ([fieldName]) => !relationFieldNames.has(fieldName),
          ),
        );
        if (Object.keys(fields).length === 0) continue;
        await safeKy.patch(recordsUrl, {
          headers,
          json: { id: Id, fields },
        });
      }
    },
    linkRecords: async (
      fieldId: string,
      recordId: string | number,
      relatedIds: (string | number)[],
    ) => {
      await safeKy
        .post(
          `${dataUrl}/links/${encodeURIComponent(fieldId)}/${encodeURIComponent(String(recordId))}`,
          {
            headers,
            json: relatedIds.map((id) => ({ id })),
          },
        )
        .json();
    },
  };
};

type NocoDbRecord = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields?: Record<string, any>;
};

const normalizeRecord = (
  record: NocoDbRecord,
  relationFieldNames: ReadonlySet<string> = new Set<string>(),
) => ({
  Id: record.id,
  ...record.id_fields,
  ...Object.fromEntries(
    Object.entries(record.fields ?? {}).map(([key, value]) => [
      key,
      relationFieldNames.has(key) ? normalizeFieldValue(value) : value,
    ]),
  ),
});

const normalizeFieldValue = (value: any): any => {
  if (Array.isArray(value)) return value.map(normalizeFieldValue);
  if (
    value &&
    typeof value === "object" &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    value.fields &&
    typeof value.fields === "object"
  )
    return normalizeRecord(value);
  return value;
};
