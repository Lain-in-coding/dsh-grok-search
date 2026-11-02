// Self-contained so the client build can embed this same validator without
// shipping a second schema implementation or adding a browser dependency.
export function createSettingsCodec(typeSymbol, jsonSchema) {
  const invalid = () => { throw new TypeError('Invalid settings payload.'); };
  const json = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { for (const item of value) json(item); return; }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) json(item); return; }
    invalid();
  };
  const validate = (value, schema) => {
    if (schema.anyOf) {
      for (const alternative of schema.anyOf) {
        try { validate(value, alternative); return; } catch {}
      }
      invalid();
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(kind)) invalid();
    if (kind === 'number' && !Number.isFinite(value)) invalid();
    if (kind === 'object') {
      for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) invalid();
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(schema.properties ?? {}, key)) validate(item, schema.properties[key]);
        else if (schema.additionalProperties === false) invalid();
        else json(item);
      }
    }
    if (kind === 'array') for (const item of value) validate(item, schema.items);
  };
  const parse = value => { validate(value, jsonSchema); return value; };
  return Object.freeze({
    mode: 'strict', typeSymbol,
    create: () => ({ parse, safeParse(value) {
      try { return { success: true, data: parse(value) }; }
      catch (error) { return { success: false, error }; }
    } }),
    get jsonSchema() { return structuredClone(jsonSchema); },
  });
}
