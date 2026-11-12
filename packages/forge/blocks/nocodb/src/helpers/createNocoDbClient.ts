import { safeKy } from "@typebot.io/lib/ky";
import { defaultBaseUrl } from "../constants";
import type { ListTableRecordsResponse, TableMetaResponse } from "../types";
import { resolveNocoDbBaseId } from "./resolveNocoDbBaseId";

type Params = {
  baseUrl?: string;
  baseId?: string;
  tableId: string;
  apiKey: string;
};

type DataRecord = {
  id: string | number;
  id_fields?: Record<string, any>;
  fields?: Record<string, any>;
};

export const createNocoDbClient = ({
  baseUrl,
  baseId,
  tableId,
  apiKey,
}: Params) => {
  const host = baseUrl ?? defaultBaseUrl;
  const headers = { "xc-token": apiKey };
  let baseIdPromise: Promise<string> | undefined;
  const getBaseId = () => {
    baseIdPromise ??= resolveNocoDbBaseId({ baseUrl, baseId, tableId, apiKey });
    return baseIdPromise;
  };
  const getDataUrl = async () =>
    `${host}/api/v3/data/${encodeURIComponent(await getBaseId())}/${encodeURIComponent(tableId)}`;
  let tablePromise: Promise<TableMetaResponse> | undefined;

  const readTable = () => {
    tablePromise ??= getBaseId().then((resolvedBaseId) =>
      safeKy
        .get(
          `${host}/api/v3/meta/bases/${encodeURIComponent(resolvedBaseId)}/tables/${encodeURIComponent(tableId)}`,
          { headers },
        )
        .json<TableMetaResponse>(),
    );
    return tablePromise;
  };

  // v3 writes replace link sets. Keep links out of ordinary writes so the
  // existing relation helper can continue adding links without removing any.
  const ordinaryFields = async (fields: Record<string, any>) => {
    const table = await readTable();
    const relationNames = new Set(
      table.fields
        .filter((field) =>
          ["Links", "LinkToAnotherRecord"].includes(field.type),
        )
        .flatMap((field) => [field.id, field.title]),
    );
    return Object.fromEntries(
      Object.entries(fields).filter(([name]) => !relationNames.has(name)),
    );
  };

  return {
    create: async (fields: Record<string, any>) => {
      const response = await safeKy
        .post(`${await getDataUrl()}/records`, {
          headers,
          json: { fields: await ordinaryFields(fields) },
        })
        .json<{ records: DataRecord[] }>();
      const record = response.records[0];
      if (!record) throw new Error("NocoDB did not return the created record");
      return { Id: record.id };
    },
    list: async (
      searchParams: Record<string, string>,
    ): Promise<ListTableRecordsResponse> => {
      const { limit = "1000", ...filters } = searchParams;
      const maximum = Number(limit);
      const records: DataRecord[] = [];
      let hasNext = true;
      while (hasNext && records.length < maximum) {
        const response = await safeKy
          .get(`${await getDataUrl()}/records`, {
            headers,
            searchParams: {
              ...filters,
              limit: String(maximum - records.length),
              offset: String(records.length),
            },
          })
          .json<{ records: DataRecord[]; next?: string | null }>();
        if (response.records.length === 0) break;
        records.push(...response.records.slice(0, maximum - records.length));
        hasNext = Boolean(response.next);
      }
      const { count } = await safeKy
        .get(`${await getDataUrl()}/count`, { headers, searchParams: filters })
        .json<{ count: number }>();
      const table = await readTable();
      const relationNames = table.fields
        .filter((field) => field.type === "LinkToAnotherRecord")
        .map((field) => field.title);
      const list = records.map((record) => {
        const row = flattenRecord(record);
        for (const name of relationNames) {
          const value = row[name];
          if (Array.isArray(value)) {
            row[name] = value.map((item) =>
              isDataRecord(item) ? flattenRecord(item) : item,
            );
          } else if (isDataRecord(value)) {
            row[name] = flattenRecord(value);
          }
        }
        return row;
      });
      return {
        list,
        pageInfo: {
          totalRows: count,
          page: 1,
          pageSize: list.length,
          isFirstPage: true,
          isLastPage: count <= list.length,
        },
      };
    },
    update: async (records: Record<string, any>[]) => {
      // Single-record writes respect deployment-specific bulk ceilings.
      for (const { Id, ...fields } of records) {
        const writableFields = await ordinaryFields(fields);
        if (Object.keys(writableFields).length === 0) continue;
        await safeKy.patch(`${await getDataUrl()}/records`, {
          headers,
          json: { id: Id, fields: writableFields },
        });
      }
    },
  };
};

const flattenRecord = (record: DataRecord) => ({
  Id: record.id,
  ...record.id_fields,
  ...record.fields,
});

const isDataRecord = (value: unknown): value is DataRecord =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  (typeof value.id === "string" || typeof value.id === "number") &&
  "fields" in value &&
  typeof value.fields === "object" &&
  value.fields !== null;
