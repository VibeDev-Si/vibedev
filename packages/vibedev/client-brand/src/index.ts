/**
 * VibeDev browser-brand plugin, node half. The empty apply gives Loader a
 * host-side row while the browser half ships through `exports["./client"]`.
 *
 * @module @vibedev/dsh-client-brand
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}
