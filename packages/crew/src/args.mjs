// A command's --flags, by node:util's parseArgs.
import { parseArgs } from 'node:util'

// argv's flags and positionals. `strings` are the flags that take a value,
// `booleans` those that take none, each spelled in full ('--state-dir');
// `values` is keyed the same way. A flag no one declared throws
// `unexpected <flag>` (err.kind 'unexpected'); a value flag with no value, or
// with another --flag where its value goes, `<flag> needs a value` (err.kind
// 'value'), unless `dashValues` lets a value start with --. The last of a
// repeated flag wins. `lenient` throws nothing: a flag no one declared, or a
// value flag with no value, is `true`.
export function parseFlags(argv, { strings = [], booleans = [], dashValues = false, lenient = false } = {}) {
  const options = Object.fromEntries([...strings.map((f) => [f.slice(2), { type: 'string' }]), ...booleans.map((f) => [f.slice(2), { type: 'boolean' }])])
  const { values, positionals, tokens } = parseArgs({ args: argv, options, strict: false, allowPositionals: true, tokens: true })
  const fail = (kind, message) => {
    throw Object.assign(new Error(message), { kind })
  }
  for (const t of tokens) {
    if (lenient || t.kind !== 'option') continue
    const type = Object.hasOwn(options, t.name) && t.rawName.startsWith('--') ? options[t.name].type : null
    if (!type || (type === 'boolean' && t.inlineValue)) fail('unexpected', `unexpected ${t.rawName}`)
    if (type === 'string' && (t.value === undefined || (!dashValues && !t.inlineValue && t.value.startsWith('--')))) fail('value', `${t.rawName} needs a value`)
  }
  return { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [`--${k}`, v])), positionals }
}
