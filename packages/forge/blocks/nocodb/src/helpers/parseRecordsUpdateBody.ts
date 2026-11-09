export const parseRecordsUpdateBody = (
  ids: (string | number)[],
  updates: { fieldName?: string; value?: string }[],
): Record<string, any>[] =>
  ids.map((id) => {
    const record: Record<string, any> = {};

    updates.forEach(({ fieldName, value }) => {
      if (!fieldName) return;
      record[fieldName] = value ?? null;
    });

    return { id, fields: record };
  });
