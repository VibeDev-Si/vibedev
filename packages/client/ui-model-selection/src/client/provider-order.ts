/** Shared provider display order for the composer and command model pickers. */

/**
 * VibeDev: the VibeDev account plugin's route (`vibedev-gateway`) leads, then the DeepSeek account and official
 * routes; every other provider keeps its catalog order after them.
 */
const LEADING_PROVIDERS: readonly string[] = ['vibedev-gateway', 'deepseek-account', 'deepseek-official']

/**
 * Rank the VibeDev, DeepSeek account and official routes ahead of other providers.
 * @param id - provider route id.
 * @returns the provider's place among the leading ones, or one past them.
 */
export function providerRank(id: string): number {
  const rank = LEADING_PROVIDERS.indexOf(id)
  return rank < 0 ? LEADING_PROVIDERS.length : rank
}

/**
 * Put the VibeDev, account and official providers first, preserving every other relative order.
 * @param groups - Provider groups in catalog order.
 * @returns a sorted copy; model order within each group is unchanged.
 */
export function orderModelProviders<T extends { readonly id: string }>(groups: readonly T[]): T[] {
  return groups.toSorted((left, right) => providerRank(left.id) - providerRank(right.id))
}
