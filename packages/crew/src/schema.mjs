// The JSON Schema subset workflow.template.js writes: type, required,
// properties, items, enum, plus additionalProperties:false and min/maxItems,
// which the template also uses and the Workflow runner enforces. Anything
// else in a schema is ignored, as `description` is. Shared by submit (the
// worker's check) and the runner (its re-check), so both reject alike.

const IS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

// Every error, not the first: the worker repairs its payload in one pass.
export function validate(schema, value, path = '$') {
  const errors = []
  if (schema.type !== undefined) {
    const types = [].concat(schema.type)
    if (!types.some((t) => IS[t] && IS[t](value))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${kindOf(value)}`)
      return errors
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }
  if (IS.object(value)) {
    const props = schema.properties || {}
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property "${key}"`)
    }
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) errors.push(...validate(props[key], v, `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`)
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: expected at most ${schema.maxItems} items, got ${value.length}`)
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)))
  }
  return errors
}

// The Workflow runner throws at agent() on a schema no result can satisfy;
// the Orca runner throws on the same two shapes before launching anyone.
export function checkSchema(schema) {
  if (!IS.object(schema) || schema.type !== 'object' || !IS.object(schema.properties)) {
    throw new Error('agent() schema needs {type: "object", properties} at its root')
  }
  const undefinedRequired = (schema.required || []).filter((k) => !Object.hasOwn(schema.properties, k))
  if (undefinedRequired.length) throw new Error(`agent() schema requires properties it does not define: ${undefinedRequired.join(', ')}`)
}
