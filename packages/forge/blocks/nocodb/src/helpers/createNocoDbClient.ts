import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl, defaultLimitForSearch } from "../constants";
import type { ListTableRecordsResponse, TableMetaResponse } from "../types";

export const createNocoDbClient = ({
  baseUrl,
  baseId,
  tableId,
  apiKey,
}: {
  baseUrl: string | undefined;
  baseId: string;
  tableId: string;
  apiKey: string;
}) => {
  const instanceUrl = baseUrl ?? defaultBaseUrl;
  const encodedBaseId = encodeURIComponent(baseId);
  const encodedTableId = encodeURIComponent(tableId);
  const tableUrl = `${instanceUrl}/api/v3/data/${encodedBaseId}/${encodedTableId}`;
  const headers = { "xc-token": apiKey };
  let tableMeta: Promise<TableMetaResponse> | undefined;

  const getTableMeta = () => {
    tableMeta ??= safeKy
      .get(
        `${instanceUrl}/api/v3/meta/bases/${encodedBaseId}/tables/${encodedTableId}`,
        { headers },
      )
      .json<{
        fields: Array<{
          id: string;
          title: string;
          type: TableMetaResponse["columns"][number]["uidt"];
        }>;
      }>()
      .then(({ fields }) => ({
        columns: fields.map(({ id, title, type }) => ({
          id,
          title,
          uidt: type,
        })),
      }));
    return tableMeta;
  };

  // V3 writes replace link sets. Keep links out of ordinary writes so the
  // existing relation helper can continue to append through the link endpoint.
  const withoutRelations = async (fields: Record<string, any>) => {
    const metadata = await getTableMeta();
    const relationFields = new Set(
      metadata.columns
        .filter(
          (column) =>
            column.uidt === "LinkToAnotherRecord" || column.uidt === "Links",
        )
        .flatMap((column) => [column.title, column.id]),
    );
    return Object.fromEntries(
      Object.entries(fields).filter(([name]) => !relationFields.has(name)),
    );
  };

  return {
    getTableMeta,
    createRecord: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(`${tableUrl}/records`, {
          headers,
          json: { fields: await withoutRelations(fields) },
        })
        .json<{ records: DataRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB did not return the created record");
      return { Id: record.id };
    },
    listRecords: async (
      searchParams: Record<string, string>,
    ): Promise<ListTableRecordsResponse> => {
      const limit = Number(searchParams.limit ?? defaultLimitForSearch);
      const list: ListTableRecordsResponse["list"] = [];
      let hasNext = true;

      while (hasNext && list.length < limit) {
        const response = await safeKy
          .get(`${tableUrl}/records`, {
            headers,
            searchParams: {
              ...searchParams,
              limit: Math.min(100, limit - list.length).toString(),
              offset: list.length.toString(),
            },
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        list.push(...response.records.map(flattenRecord));
        hasNext = Boolean(response.next) && response.records.length > 0;
      }

      // Retain the old handler's totalRows-based selection behavior, including
      // its existing fallback when an index lies outside the retrieved limit.
      const countParams: Record<string, string> = {};
      if (searchParams.where !== undefined)
        countParams.where = searchParams.where;
      if (searchParams.viewId !== undefined)
        countParams.viewId = searchParams.viewId;
      const { count } = await safeKy
        .get(`${tableUrl}/count`, { headers, searchParams: countParams })
        .json<{ count: number }>();
      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: limit,
          isFirstPage: true,
          isLastPage: !hasNext,
        },
      };
    },
    updateRecords: async (records: Array<Record<string, any>>) => {
      const updates = [];
      for (const { Id, ...fields } of records) {
        const ordinaryFields = await withoutRelations(fields);
        if (Object.keys(ordinaryFields).length > 0)
          updates.push({ id: Id, fields: ordinaryFields });
      }
      // The documented default cap is ten records per write request.
      for (let offset = 0; offset < updates.length; offset += 10) {
        await safeKy.patch(`${tableUrl}/records`, {
          headers,
          json: updates.slice(offset, offset + 10),
        });
      }
    },
    linkRecords: async (
      fieldId: string,
      recordId: string | number,
      relatedIds: Array<string | number>,
    ) => {
      if (relatedIds.length === 0) return;
      return safeKy
        .post(
          `${tableUrl}/links/${encodeURIComponent(fieldId)}/${encodeURIComponent(recordId)}`,
          {
            headers,
            json: relatedIds.map((id) => ({ id })),
          },
        )
        .json();
    },
  };
};

type DataRecord = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields: Record<string, any>;
};

const flattenRecord = (record: DataRecord): ListTableRecordsResponse["list"][number] => ({
  ...record.fields,
  ...record.id_fields,
  Id: record.id,
});
