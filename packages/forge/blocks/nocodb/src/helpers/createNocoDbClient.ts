import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse } from "../types";
import { parseSearchParams } from "./parseSearchParams";

export const createNocoDbClient = ({
  baseUrl,
  apiKey,
  baseId,
  tableId,
}: {
  baseUrl: string | undefined;
  apiKey: string;
  baseId: string | undefined;
  tableId: string | undefined;
}) => {
  if (!baseId) throw new Error("Base ID is required");
  if (!tableId) throw new Error("Table ID is required");

  const origin = baseUrl ?? defaultBaseUrl;
  const basePath = encodeURIComponent(baseId);
  const tablePath = encodeURIComponent(tableId);
  const dataUrl = `${origin}/api/v3/data/${basePath}/${tablePath}`;
  const headers = { "xc-token": apiKey };
  let tablePromise: Promise<TableSchema> | undefined;
  const getTable = () => {
    tablePromise ??= safeKy
      .get(`${origin}/api/v3/meta/bases/${basePath}/tables/${tablePath}`, {
        headers,
      })
      .json<TableSchema>();
    return tablePromise;
  };
  const getWritableFields = async (fields: Record<string, any>) => {
    const table = await getTable();
    const relations = table.fields.filter(isRelation);
    // Link writes in v3 replace links. Keep additive linking in the link endpoint.
    return Object.fromEntries(
      Object.entries(fields).filter(
        ([key]) => !relations.some((field) => field.title === key || field.id === key),
      ),
    );
  };

  return {
    getTable,
    create: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(`${dataUrl}/records`, {
          headers,
          json: { fields: await getWritableFields(fields) },
        })
        .json<{ records: DataRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB did not return the created record");
      return { Id: record.id };
    },
    list: async ({
      where,
      viewId,
      limit,
    }: {
      where: string | undefined;
      viewId: string | undefined;
      limit: number;
    }): Promise<ListTableRecordsResponse> => {
      const table = await getTable();
      const list: ListTableRecordsResponse["list"] = [];
      while (list.length < limit) {
        const response = await safeKy
          .get(`${dataUrl}/records`, {
            headers,
            searchParams: parseSearchParams({
              where,
              viewId,
              limit: Math.min(100, limit - list.length),
              offset: list.length,
              linksAsLtar: "true",
            }),
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        list.push(...response.records.map((record) => flattenRecord(record, table)));
        if (!response.next || response.records.length === 0) break;
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
          pageSize: list.length,
          isFirstPage: true,
          isLastPage: list.length >= count,
        },
      };
    },
    update: async (records: Record<string, any>[]) => {
      for (const { Id: id, ...values } of records) {
        const fields = await getWritableFields(values);
        if (Object.keys(fields).length === 0) continue;
        // Single-record requests also work with deployments using lower bulk caps.
        await safeKy.patch(`${dataUrl}/records`, {
          headers,
          json: { id, fields },
        });
      }
    },
    link: async (fieldId: string, recordId: string | number, ids: string[]) =>
      safeKy
        .post(
          `${dataUrl}/links/${encodeURIComponent(fieldId)}/${encodeURIComponent(recordId)}`,
          { headers, json: ids.map((id) => ({ id })) },
        )
        .json(),
  };
};

type TableSchema = {
  fields: { id: string; title: string; type: string }[];
};

type DataRecord = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields?: Record<string, any>;
};

const isRelation = (field: TableSchema["fields"][number]) =>
  field.type === "Links" || field.type === "LinkToAnotherRecord";

const flattenRecord = (record: DataRecord, table: TableSchema) => {
  const fields = { ...record.fields, ...record.id_fields };
  for (const field of table.fields.filter(isRelation)) {
    if (field.title in fields)
      fields[field.title] = flattenLinkedValue(fields[field.title]);
  }
  return { ...fields, Id: record.id };
};

const flattenLinkedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(flattenLinkedValue);
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    (typeof value.id !== "string" && typeof value.id !== "number")
  )
    return value;
  const fields =
    "fields" in value && value.fields !== null && typeof value.fields === "object"
      ? value.fields
      : {};
  const primaryFields =
    "id_fields" in value && value.id_fields !== null && typeof value.id_fields === "object"
      ? value.id_fields
      : {};
  return { ...fields, ...primaryFields, Id: value.id };
};
