import assert from 'node:assert/strict'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

// Run compilation before worker timing tests, rather than competing with their
// bounded work budgets. Use the production strict flags and emitted public API.
const root = fileURLToPath(new URL('../', import.meta.url))
const config = ts.readConfigFile(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), ts.sys.readFile)
assert.equal(config.error, undefined)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const fixture = fileURLToPath(new URL('../type-tests/event-runtime-ports.ts', import.meta.url))
const program = ts.createProgram([fixture], { ...parsed.options, rootDir: root, noEmit: true })
const errors = ts.getPreEmitDiagnostics(program)
assert.deepEqual(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')), [])
console.log('public runtime type contracts passed with production strict flags')
