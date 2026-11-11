export type VoicesResponse = {
  voices: {
    name: string;
    voice_id: string;
  }[];
  has_more: boolean;
  next_page_token?: string | null;
};

export type ModelsResponse = {
  model_id: string;
  name: string;
  can_do_text_to_speech: boolean;
}[];
