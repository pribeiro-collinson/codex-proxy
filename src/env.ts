const ENV_REF = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))$/;

export function resolveSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = ENV_REF.exec(trimmed);
  if (!match) return trimmed;
  const name = match[1] ?? match[2];
  if (!name) return undefined;
  const resolved = env[name]?.trim();
  return resolved || undefined;
}

export function joinUrl(base: string, suffix: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedSuffix = suffix.replace(/^\/+/, "");
  if (trimmedBase.endsWith(`/${trimmedSuffix}`) || trimmedBase.endsWith(trimmedSuffix)) {
    return trimmedBase;
  }
  return `${trimmedBase}/${trimmedSuffix}`;
}
