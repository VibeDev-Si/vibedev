/** One pnpm release-age exemption per package after the profile folds what pnpm appended. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'
import { normalizeReleaseAgePolicy } from '../src/release-age-policy.ts'

function fixture(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'release-age-policy-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const filename = join(dir, 'pnpm-workspace.yaml')
  if (text !== undefined) writeFileSync(filename, text)
  return { dir, filename }
}

function entriesOf(text: string): readonly string[] {
  return (parse(text) as { minimumReleaseAgeExclude?: string[] }).minimumReleaseAgeExclude ?? []
}

/**
 * The rule pnpm's own reader decides one package by, replicated from 11.7.0
 * `dist/pnpm.mjs:64074` (`evaluateVersionPolicy`): the first rule whose name
 * matches decides it, a name with no version allows every version, and no later
 * rule for that name is consulted.
 */
function pnpmRule(text: string, name: string): readonly string[] | true | false {
  for (const entry of entriesOf(text)) {
    const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@')
    const entryName = at === -1 ? entry : entry.slice(0, at)
    if (entryName !== name) continue
    return at === -1 ? true : entry.slice(at + 1).split('||')
  }
  return false
}

it('folds the exact entry a later install appended into the first entry that hid it', async () => {
  const original = "minimumReleaseAgeExclude:\n  - 'dsh-film@0.1.0||0.1.1||0.3.0'\n  - 'dsh-film@0.3.1'\n"
  const { dir, filename } = fixture(original)
  // Before the fold, the version pnpm approved is invisible to pnpm's own rule reader.
  expect(pnpmRule(original, 'dsh-film')).toEqual(['0.1.0', '0.1.1', '0.3.0'])
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  const text = readFileSync(filename, 'utf8')
  expect(entriesOf(text)).toEqual(['dsh-film@0.1.0||0.1.1||0.3.0||0.3.1'])
  expect(pnpmRule(text, 'dsh-film')).toEqual(['0.1.0', '0.1.1', '0.3.0', '0.3.1'])
})

it.each([
  ['a package released three times', "  - 'kit@1.1.0'\n  - 'kit@1.4.0'\n  - 'kit@1.5.0'\n", ['kit@1.1.0||1.4.0||1.5.0']],
  ['identical entries', "  - 'kit@1.0.0'\n  - 'kit@1.0.0'\n", ['kit@1.0.0']],
  ['a scoped package', "  - '@scope/kit@1.0.0'\n  - '@scope/kit@1.1.0'\n", ['@scope/kit@1.0.0||1.1.0']],
  ['a repeated and respelled version', "  - 'kit@1.0.0||1.0.0'\n  - 'kit@v1.0.0'\n", ['kit@1.0.0']],
  ['an explicitly typed string', "  - !!str 'kit@1.0.0'\n  - 'kit@1.1.0'\n", ['kit@1.0.0||1.1.0']],
  ['two packages at once', "  - 'a@1.0.0'\n  - 'b@2.0.0'\n  - 'a@1.1.0'\n  - 'b@2.1.0'\n", ['a@1.0.0||1.1.0', 'b@2.0.0||2.1.0']],
])('folds %s into one entry', async (_label, list, expected) => {
  const { dir, filename } = fixture(`minimumReleaseAgeExclude:\n${list}`)
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  expect(entriesOf(readFileSync(filename, 'utf8'))).toEqual(expected)
})

it('keeps the first position and every other entry where it was', async () => {
  const { dir, filename } = fixture("minimumReleaseAgeExclude:\n  - 'first@1.0.0'\n  - 'kit@1.0.0'\n  - 'other@2.0.0'\n  - 'kit@1.1.0'\n")
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  expect(entriesOf(readFileSync(filename, 'utf8'))).toEqual(['first@1.0.0', 'kit@1.0.0||1.1.0', 'other@2.0.0'])
})

it('preserves the file\'s comments, other settings and pending build decisions', async () => {
  const { dir, filename } = fixture([
    '# profile settings',
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'allowBuilds:',
    '  native: set this to true or false',
    'minimumReleaseAgeExclude:',
    "  - 'kit@1.0.0' # approved by hand",
    "  - 'kit@1.1.0'",
    'overrides:',
    '  left-pad: 1.3.0',
    '',
  ].join('\n'))
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(text).toContain('# approved by hand')
  expect(text).toContain('set this to true or false')
  expect(parse(text)).toEqual({
    packages: ['.'],
    nodeLinker: 'hoisted',
    allowBuilds: { native: 'set this to true or false' },
    minimumReleaseAgeExclude: ['kit@1.0.0||1.1.0'],
    overrides: { 'left-pad': '1.3.0' },
  })
})

it.each([
  ['a line comment', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  - 'kit@1.1.0' # wait for the security review\n"],
  ['a comment above', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  # wait for the security review\n  - 'kit@1.1.0'\n"],
])('folds an annotated duplicate without dropping its note: %s', async (_label, original) => {
  const { dir, filename } = fixture(original)
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  const text = readFileSync(filename, 'utf8')
  // The first entry gains the version; the annotated duplicate stays where its author put it.
  expect(entriesOf(text)).toEqual(['kit@1.0.0||1.1.0', 'kit@1.1.0'])
  expect(text).toContain('# wait for the security review')
  expect(await normalizeReleaseAgePolicy(dir)).toBe(false)
  expect(readFileSync(filename, 'utf8')).toBe(text)
})

it('folds one package while every package carrying a wider rule keeps its policy', async () => {
  const original = "minimumReleaseAgeExclude:\n  - 'a@1.0.0'\n  - 'b@2.0.0'\n  - b\n  - c\n  - 'a@1.1.0'\n  - 'b@2.1.0'\n  - 'c@3.0.0'\n"
  const { dir, filename } = fixture(original)
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  const text = readFileSync(filename, 'utf8')
  // `b` and `c` carry a bare rule their author wrote: both packages are left alone, shadowed exact
  // entries included, so each keeps the rule pnpm read before this ran.
  expect(entriesOf(text)).toEqual(['a@1.0.0||1.1.0', 'b@2.0.0', 'b', 'c', 'b@2.1.0', 'c@3.0.0'])
  expect(pnpmRule(text, 'a')).toEqual(['1.0.0', '1.1.0'])
  expect(pnpmRule(text, 'b')).toEqual(pnpmRule(original, 'b'))
  expect(pnpmRule(text, 'c')).toEqual(pnpmRule(original, 'c'))
  expect(pnpmRule(text, 'c')).toBe(true)
})

it.each([
  ['a single entry', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n"],
  ['an annotated duplicate that adds nothing', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0||1.1.0'\n  - 'kit@1.1.0' # wait for review\n"],
  ['distinct packages', "minimumReleaseAgeExclude:\n  - 'a@1.0.0'\n  - 'b@1.0.0'\n"],
  ['a bare name twice', 'minimumReleaseAgeExclude:\n  - kit\n  - kit\n'],
  ['a bare name beside an exact version', "minimumReleaseAgeExclude:\n  - kit\n  - 'kit@1.0.0'\n"],
  ['a wildcard name beside an exact version', "minimumReleaseAgeExclude:\n  - '@scope/*'\n  - '@scope/kit@1.0.0'\n"],
  ['a wildcard name carrying versions', "minimumReleaseAgeExclude:\n  - '@scope/*@1.0.0'\n  - '@scope/kit@1.0.0'\n"],
  ['an exclusion pattern carrying versions', "minimumReleaseAgeExclude:\n  - '!kit@1.0.0'\n  - 'kit@1.0.0'\n"],
  ['a brace form carrying versions', "minimumReleaseAgeExclude:\n  - 'kit{beta}@1.0.0'\n  - 'kit@1.0.0'\n"],
  ['a question mark carrying versions', "minimumReleaseAgeExclude:\n  - 'kit?@1.0.0'\n  - 'kit@1.0.0'\n"],
  ['a spaced name carrying versions', "minimumReleaseAgeExclude:\n  - 'kit dev@1.0.0'\n  - 'kit@1.0.0'\n"],
  ['a range beside an exact version', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  - 'kit@^1.0.0'\n"],
  ['a partial version beside an exact one', "minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  - 'kit@1.1'\n"],
  ['a tag beside an exact version', "minimumReleaseAgeExclude:\n  - 'kit@latest'\n  - 'kit@1.1.0'\n"],
  ['an alias item', "shared: &kit 'kit@1.0.0'\nminimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  - *kit\n"],
  ['an anchored item', "minimumReleaseAgeExclude:\n  - &kit 'kit@1.0.0'\n  - 'kit@1.1.0'\n"],
  ['a custom tag', "minimumReleaseAgeExclude:\n  - !keep 'kit@1.0.0'\n  - 'kit@1.1.0'\n"],
  ['a nested mapping item', "minimumReleaseAgeExclude:\n  - { name: kit }\n  - 'kit@1.1.0'\n"],
  ['a non-string item', "minimumReleaseAgeExclude:\n  - 1.0\n  - 'kit@1.1.0'\n"],
  ['an absent key', 'nodeLinker: hoisted\n'],
  ['an empty sequence', 'minimumReleaseAgeExclude: []\n'],
  ['a null value', 'minimumReleaseAgeExclude:\n'],
  ['comments only', '# nothing to fold\n'],
])('leaves the file byte-identical: %s', async (_label, original) => {
  const { dir, filename } = fixture(original)
  expect(await normalizeReleaseAgePolicy(dir)).toBe(false)
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('writes once and leaves the file byte-identical on the next pass', async () => {
  const { dir, filename } = fixture("minimumReleaseAgeExclude:\n  - 'kit@1.0.0'\n  - 'kit@1.1.0'\n")
  expect(await normalizeReleaseAgePolicy(dir)).toBe(true)
  const once = readFileSync(filename, 'utf8')
  expect(once.endsWith('\n')).toBe(true)
  expect(await normalizeReleaseAgePolicy(dir)).toBe(false)
  expect(readFileSync(filename, 'utf8')).toBe(once)
})

it.each([
  ['malformed YAML', 'minimumReleaseAgeExclude: [\n'],
  ['a root that is not a mapping', '[]\n'],
  ['an exemption value that is not a sequence', 'minimumReleaseAgeExclude: false\n'],
  ['an exemption value that is a mapping', 'minimumReleaseAgeExclude:\n  kit: 1.0.0\n'],
])('refuses %s without rewriting it', async (_label, original) => {
  const { dir, filename } = fixture(original)
  await expect(normalizeReleaseAgePolicy(dir)).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('reports no change for a profile without workspace settings', async () => {
  const { dir, filename } = fixture()
  expect(await normalizeReleaseAgePolicy(dir)).toBe(false)
  expect(existsSync(filename)).toBe(false)
})

it('reports unreadable workspace settings', async () => {
  const { dir, filename } = fixture()
  mkdirSync(filename)
  await expect(normalizeReleaseAgePolicy(dir)).rejects.toThrow()
})
