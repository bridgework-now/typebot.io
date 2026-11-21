import { createAuth, option } from "@typebot.io/forge";
import { defaultBaseUrl } from "./constants";

export const auth = createAuth({
  type: "encryptedCredentials",
  name: "NocoDB account",
  schema: option.object({
    baseUrl: option.string
      .meta({
        layout: {
          label: "Base URL",
          isRequired: true,
          helperText: "Change it only if you are self-hosting NocoDB.",
          withVariableButton: false,
          defaultValue: defaultBaseUrl,
        },
      })
      .transform((value) => value?.replace(/\/$/, "")),
    baseId: option.string.meta({
      layout: {
        label: "Base ID",
        isRequired: false,
        helperText:
          "Copy the base ID from the table URL to use NocoDB v3. Leave blank to retain v2 for an existing connection.",
        withVariableButton: false,
      },
    }),
    apiKey: option.string.meta({
      layout: {
        label: "API Token",
        isRequired: true,
        helperText:
          "You can generate an API token [here](https://app.nocodb.com/#/account/tokens)",
        inputType: "password",
        withVariableButton: false,
      },
    }),
  }),
});
