/** Fold pnpm's duplicated release-age exemptions for one package into their first entry. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { valid } from 'semver'
import { isMap, isScalar, isSeq, parseDocument, type Scalar } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** The workspace key holding the exact versions exempt from pnpm's release-age policy. */
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'

/**
 * A package name written as itself: an optional scope and npm's lowercase
 * characters only. pnpm's matcher globs on `*` and reads a leading `!` as an
 * exclusion pattern, and every other character it compares literally (11.7.0
 * `matcherFromPattern` / `isIgnorePattern`); a name outside this grammar — a
 * glob, an exclusion, a brace or bracket form, whitespace, a range — is left
 * alone rather than treated as an exact exemption.
 */
const LITERAL_NAME = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/

/** One exemption split into the package it names and the exact versions it allows. */
interface Exemption {
  /** The package the entry addresses. */
  readonly name: string
  /** Its exact versions in the order written, or undefined for a rule pnpm reads as broader or refuses. */
  readonly versions: readonly string[] | undefined
}

/** One list item pnpm reads as a string. */
interface Item {
  /** The scalar node the text is written back to. */
  readonly node: Scalar
  /** The entry as written. */
  readonly text: string
  /** Whether the item carries a comment of its own, which keeps it in the file. */
  readonly commented: boolean
}

/**
 * Read one exemption the way pnpm's version-policy reader does (11.7.0
 * `parseVersionPolicyRule`): the package name runs to the first `@` after a
 * leading scope marker, and every `||` part after it must be a valid exact
 * version. The name addresses its own package only when it is a literal npm name
 * (see {@link LITERAL_NAME}); anything else rules over other packages or none.
 * @param entry - one item of the exemption list.
 * @returns the package name, with its exact versions only when the entry lists nothing wider.
 */
function readExemption(entry: string): Exemption {
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@')
  if (at === -1) return { name: entry, versions: undefined }
  const name = entry.slice(0, at)
  const versions: string[] = []
  for (const raw of entry.slice(at + 1).split('||')) {
    const version = valid(raw)
    if (version === null) return { name, versions: undefined }
    versions.push(version)
  }
  if (!LITERAL_NAME.test(name)) return { name, versions: undefined }
  return { name, versions }
}

/**
 * Read one list item as a plain string. An anchor, a custom tag, an alias, or a
 * nested collection is an item whose value this module cannot rewrite without
 * changing what other parts of the document mean.
 * @param node - one item of the exemption list.
 * @returns the item, or undefined when its text is not safely addressable.
 */
function readItem(node: unknown): Item | undefined {
  if (!isScalar(node) || typeof node.value !== 'string') return undefined
  if (node.anchor !== undefined) return undefined
  if (node.tag !== undefined && node.tag !== 'tag:yaml.org,2002:str') return undefined
  return { node, text: node.value, commented: node.comment !== undefined || node.commentBefore !== undefined }
}

/**
 * Fold the release-age exemptions of any package listed more than once into its
 * first entry, leaving every other setting and comment in the file as it was.
 *
 * pnpm 11 appends `<name>@<version>` to this list for each install its
 * release-age policy would otherwise refuse, and reads the list with the first
 * rule naming a package deciding it (11.7.0 `evaluateVersionPolicy`): a package
 * already listed as `pkg@0.1.0||0.1.1` hides every exact entry appended later,
 * so the version pnpm just approved never takes effect. Folding adds no version
 * and drops none; it only stops an earlier entry from hiding a later one.
 *
 * A file this cannot read as exact exemptions is left byte for byte as it is:
 * an unreadable item, and a package carrying both a wider rule (a bare name, a
 * pattern, or a name outside npm's grammar) and exact ones, keep the policy their
 * author wrote. A duplicate entry the author annotated is kept where it is and
 * still contributes its versions to the first entry, so no note is ever dropped.
 * The file is rewritten only when at least one package's entries actually fold.
 * @param dir - the profile directory holding `pnpm-workspace.yaml`.
 * @returns whether the file was rewritten; a missing file, or one with nothing to fold, is false.
 * @throws when the file exists but cannot be read, or is not a mapping with an exemption sequence; the file is untouched.
 */
export async function normalizeReleaseAgePolicy(dir: string): Promise<boolean> {
  const path = join(dir, 'pnpm-workspace.yaml')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  // A file holding only comments is pnpm's empty settings, not a document to refuse.
  if (document.contents === null) return false
  if (!isMap(document.contents)) throw new Error('pnpm-workspace.yaml must be a YAML mapping')
  const node = document.get(EXCLUDE_KEY, true)
  if (node === undefined || (isScalar(node) && node.value === null)) return false
  if (!isSeq(node)) throw new TypeError(`pnpm-workspace.yaml: ${EXCLUDE_KEY} must be a YAML sequence`)
  const entries: { index: number; node: Scalar; exemption: Exemption; commented: boolean }[] = []
  for (const [index, item] of node.items.entries()) {
    const read = readItem(item)
    if (read === undefined) return false
    entries.push({ index, node: read.node, exemption: readExemption(read.text), commented: read.commented })
  }
  // A wider rule for a package decides it before any exact one, so folding that
  // package's exact entries would change nothing and could only misrepresent it.
  const wider = new Set(entries.filter(entry => entry.exemption.versions === undefined).map(entry => entry.exemption.name))
  const candidates = new Map<string, { node: Scalar; versions: (readonly string[])[]; duplicates: number[] }>()
  for (const entry of entries) {
    const { name, versions } = entry.exemption
    if (versions === undefined || wider.has(name)) continue
    const candidate = candidates.get(name)
    if (candidate === undefined) {
      candidates.set(name, { node: entry.node, versions: [versions], duplicates: [] })
      continue
    }
    candidate.versions.push(versions)
    // A duplicate the author annotated stays where it is: the first entry carries the version
    // either way, and deleting the item would take their explanation with it.
    if (!entry.commented) candidate.duplicates.push(entry.index)
  }
  const removals: number[] = []
  let folded = false
  for (const [name, candidate] of candidates) {
    // Every version once, in the order the file lists them.
    const merged = `${name}@${[...new Set(candidate.versions.flat())].join('||')}`
    // Repeating what the first entry already says is nothing to write, and an annotated
    // duplicate that added nothing new leaves the package exactly as its author wrote it.
    if (merged === candidate.node.value && candidate.duplicates.length === 0) continue
    folded = true
    candidate.node.value = merged
    removals.push(...candidate.duplicates)
  }
  if (!folded) return false
  // Later indices first: each removal shifts only the items after it.
  for (const index of removals.sort((left, right) => right - left)) document.deleteIn([EXCLUDE_KEY, index])
  await writeFileAtomic(path, String(document), { mode: 0o600 })
  return true
}
