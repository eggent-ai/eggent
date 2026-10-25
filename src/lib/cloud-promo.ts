/**
 * Whether the settings say a word about Eggent Cloud.
 *
 * An Eggent somebody runs on their own machine gets one short card about the
 * hosted one, beside the place where they would otherwise go and fetch an API
 * key. A deployment that brings its own models and services shows none - it
 * says so with a usage provider or a deployment context - and
 * EGGENT_CLOUD_PROMO=0 takes the card away anywhere (=1 shows it anyway).
 */
export function cloudPromoShown(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.EGGENT_CLOUD_PROMO || "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(flag)) return false;
  if (["1", "on", "true", "yes"].includes(flag)) return true;
  return !env.EGGENT_USAGE_API_URL?.trim() && !env.EGGENT_DEPLOYMENT_CONTEXT?.trim();
}
