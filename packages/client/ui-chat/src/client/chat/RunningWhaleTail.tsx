/** Animated whale mask and static SVG fallback for the running Chat status. */
import css from './ChatView.module.css'

// VibeDev fork: the VibeDev chevrons at rest instead of the whale tail; the APNG beside it pulses the same mark.
const REST_PATH = 'M2.5 3.5L8 13L13.5 3.5M5.5 3.5L8 8.2L10.5 3.5'

/**
 * Render the decorative running icon; the APNG asset owns its animation timing.
 * @returns mask and static SVG selected by browser capabilities and accessibility preferences.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningWhaleAnimated} />
      <svg className={css.runningWhaleStill} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <path d={REST_PATH} stroke="currentColor" strokeWidth={1} />
      </svg>
    </span>
  )
}
