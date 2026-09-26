import type { FunctionDeclaration } from '@google/genai';

/** JSON Schema keywords accepted by Gemini's `parametersJsonSchema`. */
const ALLOWED = new Set([
  'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
  '$defs', '$ref', '$id', '$anchor', 'propertyOrdering', 'nullable',
]);

/**
 * Converts an MCP tool's input JSON Schema into the subset Gemini accepts:
 * drops `$schema`, string-length/pattern keywords, `default`, and turns
 * `exclusiveMinimum: 0` into `minimum`. Unsafe integer bounds are removed.
 */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' || key === '$defs') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeSchema(v)]),
      );
    } else if (key === 'exclusiveMinimum' && typeof value === 'number' && !('minimum' in (node as object))) {
      out.minimum = value;
    } else if (ALLOWED.has(key)) {
      if ((key === 'maximum' || key === 'minimum') && typeof value === 'number' && Math.abs(value) > 1e15) continue;
      out[key] = sanitizeSchema(value);
    }
  }
  return out;
}

export function toFunctionDeclaration(name: string, description: string | undefined, inputSchema: unknown): FunctionDeclaration {
  const schema = sanitizeSchema(inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
  const hasParams = schema.properties && Object.keys(schema.properties as object).length > 0;
  return {
    name,
    description: description ?? '',
    ...(hasParams ? { parametersJsonSchema: schema } : {}),
  };
}
