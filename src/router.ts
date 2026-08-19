import { resolveSecret } from "./env.ts";
import type { ModelConfig, ProxyConfig, ResolvedProvider } from "./types.ts";

export function slugFor(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function listSlugs(config: ProxyConfig): string[] {
  const slugs: string[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) slugs.push(slugFor(providerId, model.id));
  }
  return slugs;
}

function resolveKey(provider: { apiKey?: string; apiKeyEnv?: string }, env: NodeJS.ProcessEnv): string | undefined {
  if (provider.apiKeyEnv) {
    const fromNamed = env[provider.apiKeyEnv]?.trim();
    if (fromNamed) return fromNamed;
  }
  return resolveSecret(provider.apiKey, env);
}

function resolved(
  providerId: string,
  provider: ProxyConfig["providers"][string],
  model: ModelConfig,
  env: NodeJS.ProcessEnv,
): ResolvedProvider {
  return {
    id: providerId,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    apiKey: resolveKey(provider, env),
    headers: provider.headers ?? {},
    model,
    slug: slugFor(providerId, model.id),
  };
}

export function routeModel(
  requested: string,
  config: ProxyConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const trimmed = requested.trim();
  if (!trimmed) throw new Error("model is required");

  const exact = matchSlug(trimmed, config, env);
  if (exact) return exact;

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const providerId = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    const provider = config.providers[providerId];
    if (provider) {
      const model = provider.models.find((item) => item.id === modelId) ?? { id: modelId };
      return resolved(providerId, provider, model, env);
    }
  }

  const matches: ResolvedProvider[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      if (model.id === trimmed || model.id.endsWith(`/${trimmed}`)) {
        matches.push(resolved(providerId, provider, model, env));
      }
    }
  }
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model '${trimmed}' is ambiguous. Use a slug: ${matches.map((item) => item.slug).join(", ")}`,
    );
  }

  const defaultProviderId = config.defaultProvider ?? Object.keys(config.providers)[0];
  if (!defaultProviderId) throw new Error("No providers configured");
  const defaultProvider = config.providers[defaultProviderId];
  if (!defaultProvider) throw new Error(`Unknown default provider '${defaultProviderId}'`);
  const fallbackModel =
    defaultProvider.models.find((item) => item.id === trimmed) ??
    defaultProvider.models.find((item) => item.id === defaultProvider.defaultModel) ??
    defaultProvider.models[0];
  if (!fallbackModel) throw new Error(`Provider '${defaultProviderId}' has no models`);
  if (trimmed === fallbackModel.id || trimmed === slugFor(defaultProviderId, fallbackModel.id)) {
    return resolved(defaultProviderId, defaultProvider, fallbackModel, env);
  }

  throw new Error(
    `Unknown model '${trimmed}'. Known slugs: ${listSlugs(config).join(", ") || "(none)"}`,
  );
}

function matchSlug(
  trimmed: string,
  config: ProxyConfig,
  env: NodeJS.ProcessEnv,
): ResolvedProvider | undefined {
  for (const [providerId, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      if (slugFor(providerId, model.id) === trimmed) {
        return resolved(providerId, provider, model, env);
      }
    }
  }
  return undefined;
}

export function defaultSlug(config: ProxyConfig): string {
  if (config.defaultModel) {
    try {
      return routeModel(config.defaultModel, config).slug;
    } catch {
      return config.defaultModel;
    }
  }
  const providerId = config.defaultProvider ?? Object.keys(config.providers)[0];
  if (!providerId) throw new Error("No providers configured");
  const provider = config.providers[providerId];
  const model =
    provider?.models.find((item) => item.id === provider.defaultModel) ?? provider?.models[0];
  if (!provider || !model) throw new Error("No models configured");
  return slugFor(providerId, model.id);
}
