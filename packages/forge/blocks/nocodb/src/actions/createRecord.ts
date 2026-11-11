import { createAction, option } from "@typebot.io/forge";
import { auth } from "../auth";

export const createRecord = createAction({
  auth,
  name: "Create Record",
  options: option.object({
    baseId: option.string.meta({
      layout: {
        label: "Base ID",
        helperText:
          "Optional for existing configurations. Set it to use the v3 metadata API. Find it in your NocoDB project URL.",
      },
    }),
    tableId: option.string.meta({
      layout: {
        label: "Table ID",
        isRequired: true,
        helperText: "Identifier of the table to create records in.",
      },
    }),
    fields: option
      .array(
        option.object({
          key: option.string.meta({
            layout: {
              label: "Field",
              isRequired: true,
            },
          }),
          value: option.string.meta({
            layout: {
              label: "Value",
              isRequired: true,
            },
          }),
        }),
      )
      .meta({
        layout: {
          itemLabel: "field",
        },
      }),
  }),
});
