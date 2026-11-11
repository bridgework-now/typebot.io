import { createActionHandler, createFetcherHandler } from "@typebot.io/forge";
import { createId } from "@typebot.io/lib/createId";
import { parseUnknownError } from "@typebot.io/lib/parseUnknownError";
import { uploadFileToBucket } from "@typebot.io/lib/s3/uploadFileToBucket";
import got from "ky";
import {
  convertTextToSpeech,
  modelsFetcher,
  voicesFetcher,
} from "./actions/convertTextToSpeech";
import { baseUrl } from "./constants";
import type { ModelsResponse, VoicesResponse } from "./type";

export default [
  createActionHandler(convertTextToSpeech, {
    server: async ({ credentials, options, variables, logs }) => {
      if (!options.voiceId) return logs.add("Voice ID is missing");
      if (!options.text) return logs.add("Text is missing");
      if (!options.saveUrlInVariableId)
        return logs.add("Save variable is missing");

      try {
        const response = await got
          .post(`${baseUrl}/v1/text-to-speech/${options.voiceId}`, {
            headers: {
              Accept: "audio/mpeg",
              "xi-api-key": credentials.apiKey,
            },
            json: {
              model_id: options.modelId,
              text: options.text,
            },
            timeout: false,
          })
          .arrayBuffer();

        const url = await uploadFileToBucket({
          file: Buffer.from(response),
          key: `tmp/elevenlabs/audio/${createId() + createId()}.mp3`,
          mimeType: "audio/mpeg",
        });

        variables.set([{ id: options.saveUrlInVariableId, value: url }]);
      } catch (err) {
        return logs.add(
          await parseUnknownError({
            err,
            context: "While converting text to ElevenLabs speech",
          }),
        );
      }
    },
  }),
  createFetcherHandler(
    convertTextToSpeech,
    voicesFetcher.id,
    async ({ credentials }) => {
      if (!credentials?.apiKey)
        return {
          data: [],
        };

      try {
        const voices: VoicesResponse["voices"] = [];
        const seenPageTokens = new Set<string>();
        let nextPageToken: string | undefined;

        while (true) {
          const searchParams = new URLSearchParams({
            page_size: "100",
            include_total_count: "false",
          });
          if (nextPageToken !== undefined)
            searchParams.set("next_page_token", nextPageToken);

          const response = await got
            .get(`${baseUrl}/v2/voices`, {
              headers: {
                "xi-api-key": credentials.apiKey,
              },
              searchParams,
            })
            .json<VoicesResponse>();

          voices.push(...response.voices);
          if (!response.has_more) break;

          if (
            !response.next_page_token ||
            seenPageTokens.has(response.next_page_token)
          )
            throw new Error(
              "ElevenLabs voice pagination returned an invalid continuation token",
            );

          nextPageToken = response.next_page_token;
          seenPageTokens.add(nextPageToken);
        }

        return {
          data: voices.map((voice) => ({
            value: voice.voice_id,
            label: voice.name,
          })),
        };
      } catch (err) {
        return {
          error: await parseUnknownError({ err }),
        };
      }
    },
  ),
  createFetcherHandler(
    convertTextToSpeech,
    modelsFetcher.id,
    async ({ credentials }) => {
      if (!credentials?.apiKey)
        return {
          data: [],
        };

      try {
        const response = await got
          .get(`${baseUrl}/v1/models`, {
            headers: {
              "xi-api-key": credentials.apiKey,
            },
          })
          .json<ModelsResponse>();

        return {
          data: response
            .filter((model) => model.can_do_text_to_speech)
            .map((model) => ({
              value: model.model_id,
              label: model.name,
            })),
        };
      } catch (err) {
        return {
          error: await parseUnknownError({ err }),
        };
      }
    },
  ),
];
