// What a schema-enforcing harness leaves a well-behaved agent to fill: every
// required field the answer omits, as `overrides` gives it or else the empty
// value of its type. The simulator and crew's fake harness both fake agents of
// the one workflow template, so they share this rather than drift apart.
const EMPTY = { array: () => [], string: () => '', boolean: () => false, integer: () => 0, number: () => 0, object: () => ({}) }

export function fillRequired(schema, answer, overrides = {}) {
  const filled = { ...answer }
  for (const key of schema.required ?? []) {
    if (key in filled) continue
    filled[key] = key in overrides ? overrides[key] : EMPTY[schema.properties?.[key]?.type]?.() ?? null
  }
  return filled
}
