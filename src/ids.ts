export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
