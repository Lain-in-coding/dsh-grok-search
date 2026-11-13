// Self-contained so the client build can embed this same validator without
// shipping a second schema implementation or adding a browser dependency.
export function createSettingsCodec(typeSymbol, jsonSchema) {
  const invalid = () => { throw new TypeError('Invalid settings payload.'); };
  const invalidSchema = () => { throw new TypeError('Invalid or unsupported settings schema.'); };
  const LIMITS = Object.freeze({
    depth: 64, nodes: 200_000, bytes: 32 * 1024 * 1024,
    schemaDepth: 32, schemaNodes: 4096, schemaBytes: 1024 * 1024,
  });
  const record = value => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  // Includes full history: 20 calls x 16 queries x 5,000 characters plus
  // provider receipts. Size charges conservatively bound escaped JSON bytes.
  const json = (value, maxDepth = LIMITS.depth, maxNodes = LIMITS.nodes, maxBytes = LIMITS.bytes) => {
    let nodes = 0, bytes = 0;
    const ancestors = new Set();
    const charge = amount => { bytes += amount; if (bytes > maxBytes) invalid(); };
    const visit = (item, depth) => {
      if (depth > maxDepth || ++nodes > maxNodes) invalid();
      if (item === null || typeof item === 'boolean') { charge(5); return; }
      if (typeof item === 'string') { charge(item.length * 6 + 2); return; }
      if (typeof item === 'number' && Number.isFinite(item)) { charge(24); return; }
      const array = Array.isArray(item);
      if (!(array ? Object.getPrototypeOf(item) === Array.prototype : record(item)) || ancestors.has(item)) invalid();
      if (array && item.length > maxNodes - nodes) invalid();
      const keys = Reflect.ownKeys(item);
      if (array && keys.length !== item.length + 1 || !array && keys.length > maxNodes - nodes) invalid();
      charge(2 + keys.length);
      ancestors.add(item);
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || array && !/^(0|[1-9]\d*)$/.test(key)) invalid();
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property.enumerable || !Object.hasOwn(property, 'value')) invalid();
        if (!array) charge(key.length * 6 + 3);
        visit(property.value, depth + 1);
      }
      ancestors.delete(item);
    };
    visit(value, 0);
  };

  // Deliberately small JSON Schema subset; additions must be implemented here
  // before a descriptor can use them. Enum choices are JSON scalars only.
  const keywords = new Set(['type', 'anyOf', 'enum', 'properties', 'required', 'additionalProperties',
    'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']);
  const typeNames = new Set(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']);
  try { json(jsonSchema, LIMITS.schemaDepth, LIMITS.schemaNodes, LIMITS.schemaBytes); } catch { invalidSchema(); }
  const schemaCopy = structuredClone(jsonSchema);
  let schemaNodes = 0;
  const compile = (schema, depth = 0) => {
    if (depth > LIMITS.schemaDepth || ++schemaNodes > LIMITS.schemaNodes) invalidSchema();
    if (!record(schema) || Object.keys(schema).some(key => !keywords.has(key))) invalidSchema();
    const has = key => Object.hasOwn(schema, key);
    const types = has('type') ? Array.isArray(schema.type) ? schema.type : [schema.type] : null;
    if (types && (!types.length || types.some(type => !typeNames.has(type))
      || new Set(types).size !== types.length)) invalidSchema();
    let alternatives;
    if (has('anyOf')) {
      if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) invalidSchema();
      alternatives = schema.anyOf.map(alternative => compile(alternative, depth + 1));
    }
    let choices;
    if (has('enum')) {
      if (!Array.isArray(schema.enum) || !schema.enum.length
        || schema.enum.some(value => value !== null && typeof value === 'object')) invalidSchema();
      choices = new Set(schema.enum);
      if (choices.size !== schema.enum.length) invalidSchema();
    }
    if (has('properties') && !record(schema.properties)) invalidSchema();
    const properties = new Map(Object.entries(schema.properties ?? {})
      .map(([key, value]) => [key, compile(value, depth + 1)]));
    const required = has('required') ? schema.required : [];
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string')
      || new Set(required).size !== required.length) invalidSchema();
    const additional = has('additionalProperties') ? schema.additionalProperties : true;
    if (typeof additional !== 'boolean') invalidSchema();
    const items = has('items') ? compile(schema.items, depth + 1) : null;
    for (const key of ['minimum', 'maximum']) {
      if (has(key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])
        || !Number.isSafeInteger(schema[key] * 1_000_000))) invalidSchema();
    }
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (has(key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) invalidSchema();
    }
    let pattern;
    if (has('pattern')) {
      if (typeof schema.pattern !== 'string') invalidSchema();
      if (schema.pattern.length > 4096 || has('maxLength') && schema.maxLength > 256) invalidSchema();
      try { pattern = new RegExp(schema.pattern, 'u'); } catch { invalidSchema(); }
    }
    return (value, budget) => {
      if (++budget.steps > 1_000_000) invalid();
      const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (types && !types.includes(kind) && !(kind === 'number' && Number.isInteger(value) && types.includes('integer'))) return false;
      if (choices && !choices.has(value)) return false;
      if (alternatives && !alternatives.some(validate => validate(value, budget))) return false;
      if (kind === 'number' && (value < (has('minimum') ? schema.minimum : -Infinity)
        || value > (has('maximum') ? schema.maximum : Infinity))) return false;
      if (kind === 'string') {
        if (has('minLength') || has('maxLength')) {
          const maximum = has('maxLength') ? schema.maxLength : Infinity;
          let length = 0;
          for (const character of value) { length++; if (length > maximum) return false; }
          if (length < (has('minLength') ? schema.minLength : 0)) return false;
        }
        if (pattern && !pattern.test(value)) return false;
      }
      if (kind === 'object') {
        if (required.some(key => !Object.hasOwn(value, key))) return false;
        for (const key of Object.keys(value)) {
          const validate = properties.get(key);
          if (validate ? !validate(value[key], budget) : !additional) return false;
        }
      }
      if (kind === 'array') {
        if (value.length < (has('minItems') ? schema.minItems : 0)
          || value.length > (has('maxItems') ? schema.maxItems : Infinity)) return false;
        if (items && !value.every(item => items(item, budget))) return false;
      }
      return true;
    };
  };
  const validate = compile(schemaCopy);
  const parse = value => { json(value); if (!validate(value, { steps: 0 })) invalid(); return value; };
  const parser = Object.freeze({ parse, safeParse(value) {
    try { return { success: true, data: parse(value) }; }
    catch (error) { return { success: false, error }; }
  } });
  return Object.freeze({
    mode: 'strict', typeSymbol,
    create: () => parser,
    get jsonSchema() { return structuredClone(schemaCopy); },
  });
}
