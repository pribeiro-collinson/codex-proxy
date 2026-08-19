import { defaultSlug, listSlugs, slugFor } from "./router.ts";
import type { ModelConfig, ProxyConfig, ReasoningEffort } from "./types.ts";

const PLANS = [
  "business",
  "edu",
  "edu_plus",
  "edu_pro",
  "education",
  "enterprise",
  "free",
  "free_workspace",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
];

const DEFAULT_LEVELS: Array<{ effort: ReasoningEffort; description: string }> = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

function levelsFor(model: ModelConfig): Array<{ effort: string; description: string }> {
  if (model.reasoning === false) return [];
  const wanted = model.reasoningLevels ?? (model.reasoning ? (["low", "medium", "high"] as ReasoningEffort[]) : []);
  if (wanted.length === 0) return [];
  const descriptions = new Map(DEFAULT_LEVELS.map((level) => [level.effort, level.description]));
  descriptions.set("xhigh", "Extra high reasoning depth for complex problems");
  descriptions.set("max", "Maximum reasoning depth for the hardest problems");
  return wanted.map((effort) => ({
    effort,
    description: descriptions.get(effort) ?? effort,
  }));
}

export function catalogEntry(
  slug: string,
  model: ModelConfig,
  priority: number,
): Record<string, unknown> {
  const reasoning = levelsFor(model);
  const displayName = model.displayName ?? slug;
  return {
    slug,
    display_name: displayName,
    description: model.description ?? `${displayName} via codex-proxy`,
    context_window: model.contextWindow ?? 128000,
    max_context_window: model.contextWindow ?? 128000,
    visibility: "list",
    supported_in_api: true,
    priority,
    upgrade: null,
    availability_nux: null,
    prefer_websockets: false,
    use_responses_lite: false,
    support_verbosity: false,
    supports_search_tool: false,
    supports_reasoning_summaries: reasoning.length > 0,
    default_reasoning_level: reasoning[0]?.effort ?? "none",
    supported_reasoning_levels: reasoning,
    default_reasoning_summary: "none",
    shell_type: "shell_command",
    tool_mode: "code_mode_only",
    apply_patch_tool_type: "freeform",
    input_modalities: ["text", "image"],
    available_in_plans: PLANS,
    base_instructions: "",
  };
}

export function buildCatalog(config: ProxyConfig): { models: Record<string, unknown>[] } {
  const models: Record<string, unknown>[] = [];
  let priority = 1;
  const preferred = defaultSlug(config);
  const seen = new Set<string>();

  const push = (slug: string, model: ModelConfig) => {
    if (seen.has(slug)) return;
    seen.add(slug);
    models.push(catalogEntry(slug, model, priority));
    priority += 1;
  };

  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      const slug = slugFor(providerId, model.id);
      if (slug === preferred) push(slug, model);
    }
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) push(slugFor(providerId, model.id), model);
  }

  if (models.length === 0) {
    throw new Error(`Catalog is empty. Configured slugs: ${listSlugs(config).join(", ") || "(none)"}`);
  }
  return { models };
}
