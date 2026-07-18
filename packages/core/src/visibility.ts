import type { Visibility } from "./types.js";

/** Rank: private=0, unlisted=1, public=2 — min rank = most strict (KD-21). */
const RANK: Record<Visibility, number> = {
  private: 0,
  unlisted: 1,
  public: 2,
};

const FROM_RANK: Visibility[] = ["private", "unlisted", "public"];

/** Coerce unknown stored values to a valid Visibility (F-002). */
export function asVisibility(v: unknown, fallback: Visibility = "private"): Visibility {
  if (v === "private" || v === "unlisted" || v === "public") return v;
  return fallback;
}

export function visibilityRank(v: Visibility | string): number {
  return RANK[asVisibility(v)] ?? 0;
}

/**
 * effective_visibility(node) = min_rank(self, ancestors).
 * Pass ancestors from root→parent order or any order — min is commutative.
 * Accepts string[] from storage; narrows safely (F-002).
 */
export function effectiveVisibility(
  self: Visibility | string,
  ancestors: Array<Visibility | string> = [],
): Visibility {
  let rank = visibilityRank(asVisibility(self));
  for (const a of ancestors) {
    rank = Math.min(rank, visibilityRank(asVisibility(a)));
  }
  return FROM_RANK[rank]!;
}
