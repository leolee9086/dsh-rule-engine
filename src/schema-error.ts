import { z } from 'zod'

/**
 * Zod v4 stores `message` as an own accessor, not a data property. Structured
 * clone copies an Error by its own data properties, so a `ZodError` that crosses
 * such a boundary arrives with an empty message; `worker_threads`/`postMessage`
 * and the test runner's cross-process error relay both clone this way.
 *
 * Converting at parse boundaries keeps a rejection diagnosable after it crosses
 * one, and the original error stays available as `cause`.
 */
export function schemaError(error: unknown, what: string): Error {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const describe = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): string[] => issues.flatMap(issue => {
    const parts = [...prefix, ...issue.path]
    if (issue.code === 'invalid_union' && issue.message === 'Invalid input') return issue.errors.flatMap(branch => describe(branch, parts))
    const path = parts.length ? parts.join('.') : '(root)'
    const expected = issue.code === 'invalid_type' ? issue.expected : undefined
    const message = expected ? 'must be ' + (expected === 'array' ? 'an array' : expected === 'object' || expected === 'record' ? 'an object' : expected === 'boolean' ? 'a boolean' : expected === 'number' ? 'a finite number' : 'a ' + expected) : issue.message
    return [`${path} ${message}${message === issue.message ? '' : '; ' + issue.message}`]
  })
  const detail = describe(error.issues).join('; ')
  return new Error(`${what}: ${detail}`, { cause: error })
}

/** Run one schema parse, reporting a rejection as an error that survives relay. */
export function parseOrThrow<T>(what: string, parse: () => T): T {
  try { return parse() }
  catch (error) { throw schemaError(error, what) }
}
