/** Project the gateway's account read onto the shared account UI's profile and wallet shapes. */
import type { AccountDetails, AccountUserId } from '@deepseek-ai/dsh-deepseek-account'
import { VibeDevAuthError, type AccountMe } from './protocol.ts'

/** Decimal grammar the account UI's big.js accepts, including an exponent. */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** A ready profile outcome. */
export type ReadyProfile = Extract<AccountDetails['profile'], { status: 'ready' }>

/**
 * Project the account identity; the email stays as the gateway masks it.
 * @param me - validated `/v1/account/auth/me` data.
 * @returns ready profile with a stable string id.
 */
export function profileOf(me: AccountMe): ReadyProfile {
  const name = me.nickname?.trim() || me.username?.trim() || null
  return {
    status: 'ready',
    value: { id: String(me.id) as AccountUserId, name, contact: me.email?.trim() || null, avatarUrl: null },
  }
}

/**
 * Project the single gateway wallet. The ledger is CNY unless the gateway says otherwise; there are no bonus wallets.
 * @param me - validated `/v1/account/auth/me` data.
 * @returns ready balance outcome.
 * @throws VibeDevAuthError('protocol') for a balance the UI could not parse.
 */
export function balanceOf(me: AccountMe): Extract<AccountDetails['balance'], { status: 'ready' }> {
  const balance = typeof me.balance === 'number'
    ? (Number.isFinite(me.balance) ? String(me.balance) : '')
    : me.balance.trim()
  if (!DECIMAL.test(balance)) throw new VibeDevAuthError('protocol')
  return { status: 'ready', value: [{ currency: me.currency ?? 'CNY', balance }], bonusWallets: [] }
}
