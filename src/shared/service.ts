// Service names become the agent instance name and part of its URL
// (/agents/release-agent/<name>), so keep them to a safe, canonical form.

export const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidServiceName(name: string): boolean {
  return SERVICE_NAME.test(name);
}

/** "Checkout API" -> "checkout-api". Returns "" if nothing usable is left. */
export function normalizeServiceName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}
