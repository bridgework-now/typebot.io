import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse, TableMetaResponse } from "../types";
import { parseSearchParams } from "./parseSearchParams";

type RecordId = number | string;

type DataRecord = {
  id: RecordId;
  id_fields?: Record<string, any>;
  fields: Record<string, any>;
};

type Params = {
  baseUrl?: string;
  baseId?: string;
  apiKey: string;
  tableId: string;
};

export const createNocoDbClient = ({
  baseUrl,
  baseId,
  apiKey,
  tableId,
}: Params) => {
  if (!baseId) throw new Error("Base ID is required for NocoDB API v3");

  const origin = baseUrl ?? defaultBaseUrl;
  const encodedBaseId = encodeURIComponent(baseId);
  const encodedTableId = encodeURIComponent(tableId);
  const dataUrl = `${origin}/api/v3/data/${encodedBaseId}/${encodedTableId}`;
  const headers = { "xc-token": apiKey };
  let cachedTableMeta: TableMetaResponse | undefined;

  const readTable = async (): Promise<TableMetaResponse> => {
    if (cachedTableMeta) return cachedTableMeta;
    const table = await safeKy
      .get(
        `${origin}/api/v3/meta/bases/${encodedBaseId}/tables/${encodedTableId}`,
        { headers },
      )
      .json<{
        fields: Array<{
          id: string;
          title: string;
          type: TableMetaResponse["columns"][number]["uidt"];
        }>;
      }>();
    cachedTableMeta = {
      columns: table.fields.map((field) => ({
        id: field.id,
        title: field.title,
        uidt: field.type,
      })),
    };
    return cachedTableMeta;
  };

  return {
    readTable,
    createRecord: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(`${dataUrl}/records`, {
          headers,
          json: { fields },
        })
        .json<{ records: Array<{ id: RecordId }> }>();
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
      const tableMeta = await readTable();
      const relationFieldNames = tableMeta.columns
        .filter(isRelationField)
        .map((column) => column.title);
      const { count } = await safeKy
        .get(`${dataUrl}/count`, {
          headers,
          searchParams: parseSearchParams({ where, viewId }),
        })
        .json<{ count: number }>();
      const list: ListTableRecordsResponse["list"] = [];
      let page = 1;
      while (list.length < limit) {
        const response = await safeKy
          .get(`${dataUrl}/records`, {
            headers,
            searchParams: parseSearchParams({
              where,
              viewId,
              page,
              pageSize: Math.min(limit, 100),
            }),
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        for (const record of response.records.slice(0, limit - list.length)) {
          // v3 view queries omit hidden fields. Read each selected record
          // without the view to retain the existing field-mapping behavior.
          const completeRecord = viewId
            ? (
                await safeKy
                  .get(
                    `${dataUrl}/records/${encodeURIComponent(String(record.id))}`,
                    { headers },
                  )
                  .json<{ record: DataRecord }>()
              ).record
            : record;
          list.push(normalizeRecord(completeRecord, relationFieldNames));
        }
        if (!response.next || response.records.length === 0) break;
        // Keep credentials on the configured host, even when a reverse proxy
        // causes NocoDB to advertise a different host in its next URL.
        page++;
      }
      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: list.length,
          isFirstPage: true,
          isLastPage: list.length >= count,
        },
      };
    },
    updateRecords: async (records: Record<string, any>[]) => {
      const tableMeta = await readTable();
      const relationFieldNames = new Set(
        tableMeta.columns.filter(isRelationField).map((column) => column.title),
      );
      for (const { Id, ...values } of records) {
        // v3 PATCH replaces link sets. Relation additions are handled by
        // linkRelationUpdatesIfAny through the additive link endpoint.
        const fields = Object.fromEntries(
          Object.entries(values).filter(([name]) => !relationFieldNames.has(name)),
        );
        if (Object.keys(fields).length === 0) continue;
        // Single-record requests also respect deployments with a bulk cap
        // below the documented default of ten records.
        await safeKy.patch(`${dataUrl}/records`, {
          headers,
          json: { id: Id, fields },
        });
      }
    },
    linkRecords: async (
      fieldId: string,
      recordId: RecordId,
      relatedRecordIds: string[],
    ) => {
      if (relatedRecordIds.length === 0) return;
      await safeKy
        .post(
          `${dataUrl}/links/${encodeURIComponent(fieldId)}/${encodeURIComponent(String(recordId))}`,
          {
            headers,
            json: relatedRecordIds.map((id) => ({ id })),
          },
        )
        .json();
    },
  };
};

const isRelationField = (column: TableMetaResponse["columns"][number]) =>
  column.uidt === "LinkToAnotherRecord" || column.uidt === "Links";

const normalizeRecord = (
  record: DataRecord,
  relationFieldNames: string[],
): ListTableRecordsResponse["list"][number] => {
  const fields = { ...record.fields };
  for (const name of relationFieldNames) {
    const value = fields[name];
    fields[name] = Array.isArray(value)
      ? value.map(normalizeLinkedRecord)
      : normalizeLinkedRecord(value);
  }
  return { ...fields, ...record.id_fields, Id: record.id };
};

const normalizeLinkedRecord = (value: any): any => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("fields" in value)
  )
    return value;
  return { ...value.fields, ...value.id_fields, Id: value.id };
};
