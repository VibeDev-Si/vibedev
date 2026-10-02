/** Minimal pages the loopback callback answers the browser with; they carry no tokens or links. */
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

/** Sign-in outcome shown in the browser tab that completed authorization. */
export type CallbackOutcome = 'succeeded' | 'failed'

const COPY = {
  zh_CN: {
    succeeded: '登录成功，可以回到 VibeDev 了。',
    failed: '登录失败，请关闭此页面，回到 VibeDev 重试。',
  },
  en_US: {
    succeeded: 'Signed in. You can return to VibeDev.',
    failed: 'Sign-in failed. Close this page and try again in VibeDev.',
  },
} as const

/**
 * Answer the held callback request with a self-contained page that tries to close its own tab.
 * @param response - held callback response.
 * @param outcome - sign-in result.
 * @param locale - wire locale captured when the attempt started.
 */
export function writeCallbackPage(response: ServerResponse, outcome: CallbackOutcome, locale: 'zh_CN' | 'en_US'): void {
  const nonce = randomBytes(16).toString('base64url')
  const message = COPY[locale][outcome]
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
  }).end(`<!doctype html><html lang="${locale === 'zh_CN' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><title>VibeDev</title>`
    + `<style nonce="${nonce}">body{font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}</style>`
    + `<body><p>${message}</p><script nonce="${nonce}">window.close()</script></body></html>`)
}
