import { anthropicAdapter } from "./anthropic.ts";
import { openaiChatAdapter } from "./openai-chat.ts";
import { openaiResponsesAdapter } from "./openai-responses.ts";
import type { Adapter, AdapterId } from "../types.ts";

const ADAPTERS: Record<AdapterId, () => Adapter> = {
  "openai-chat": openaiChatAdapter,
  anthropic: anthropicAdapter,
  "openai-responses": openaiResponsesAdapter,
};

export function getAdapter(id: AdapterId): Adapter {
  const create = ADAPTERS[id];
  if (!create) throw new Error(`Unknown adapter: ${id}`);
  return create();
}

export { toChatBody } from "./openai-chat.ts";
export { toAnthropicBody } from "./anthropic.ts";
export { isPassthrough } from "./openai-responses.ts";
