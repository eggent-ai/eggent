/**
 * Which model looks back on a turn.
 *
 * Pure, so the rule can be tested without a runtime: the caller hands in what
 * the registry offers and what the workspace allows, and gets a model or
 * nothing - nothing meaning "fall back the way a chat does", which never picks
 * the included model for a workspace that is not on it.
 */
export function pickReviewCandidate<T extends { provider: string; id: string }>(params: {
  available: T[];
  /** The deployment's model for the look-back, `provider/id` or a bare id. */
  override?: string;
  /** The model the chat answered with. */
  preferred?: { provider?: string; id?: string };
  /** False keeps the look-back off the included model altogether. */
  managedAllowed: boolean;
  /** True when the person turned the included model on for the look-back. */
  managedFirst: boolean;
  isManaged: (provider: string) => boolean;
  /** The included model the deployment would answer with by default. */
  managedDefaultId?: string;
}): T | undefined {
  const { override, preferred, isManaged } = params;
  const candidates = params.managedAllowed
    ? params.available
    : params.available.filter((model) => !isManaged(model.provider));

  if (override) {
    const slash = override.indexOf("/");
    const provider = slash > 0 ? override.slice(0, slash) : undefined;
    const id = slash > 0 ? override.slice(slash + 1) : override;
    const matches = candidates.filter((model) => model.id === id && (!provider || model.provider === provider));
    const named = matches.find((model) => model.provider === preferred?.provider) ?? matches[0];
    if (named) return named;
  }

  if (params.managedFirst) {
    const managed = candidates.filter((model) => isManaged(model.provider));
    const chosen = managed.find((model) => model.id === params.managedDefaultId) ?? managed[0];
    if (chosen) return chosen;
  }

  if (preferred?.id) {
    const same = candidates.find((model) => model.provider === preferred.provider && model.id === preferred.id);
    if (same) return same;
  }
  return undefined;
}
