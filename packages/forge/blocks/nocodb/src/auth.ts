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
        isRequired: true,
        helperText:
          "Identifier of the NocoDB base containing your tables. Required by API v3; update existing saved credentials before running actions.",
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
