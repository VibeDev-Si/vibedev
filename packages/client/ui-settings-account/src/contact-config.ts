/** Public contact and bonus notice options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination and bonus notice timings shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
  /**
   * VibeDev fork: the DeepSeek account is the app's second account. Its entry sits in the sidebar foot's action row
   * and the settings launcher is left to the main account (the VibeDev account plugin's). Off: DeepSeek Harness's layout.
   */
  secondary: boolean
  /** VibeDev fork: show the product onboarding after a DeepSeek sign-in (DeepSeek Harness does; VibeDev turns it off). */
  onboarding: boolean
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'),
  contactSource: z.string().default(''),
  bonusAckRetryDelayMs: z.number().min(1).default(1_000),
  bonusAckRetryMaxDelayMs: z.number().min(1).default(60_000),
  secondary: z.boolean().default(false),
  onboarding: z.boolean().default(true),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'
