const issue = (message, path = []) => ({ issues: [{ message, path }] });
const nullable = value => value === null || value === undefined;

function validate(value) {
  const input = nullable(value) ? {} : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return issue('Expected an object.');
  const output = {};
  const executable = nullable(input.executable) ? '' : input.executable;
  if (typeof executable !== 'string') return issue('Expected a string.', ['executable']);
  output.executable = executable;
  const args = nullable(input.executableArgs) ? [] : input.executableArgs;
  if (!Array.isArray(args)) return issue('Expected an array.', ['executableArgs']);
  for (let index = 0; index < args.length; index++) {
    // The previous optional string schema also accepted null and undefined.
    if (!nullable(args[index]) && typeof args[index] !== 'string') {
      return issue('Expected a string.', ['executableArgs', index]);
    }
  }
  output.executableArgs = args.slice();
  const configPath = nullable(input.configPath) ? '' : input.configPath;
  if (typeof configPath !== 'string') return issue('Expected a string.', ['configPath']);
  output.configPath = configPath;
  const budget = nullable(input.budgetMs) ? 120_000 : input.budgetMs;
  if (typeof budget !== 'number') return issue('Expected a number.', ['budgetMs']);
  if (budget < 30_000 || budget > 120_000) return issue('Expected a number between 30000 and 120000.', ['budgetMs']);
  output.budgetMs = budget;
  // Schemastery's object schema keeps unknown enumerable fields, including inherited ones.
  for (const key in input) if (!(key in output)) output[key] = input[key];
  return { value: output };
}

export const Config = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'dsh-grok-search', validate }),
});

function invalidSchema(message) {
  return Object.assign(new TypeError(message), { code: 'COMPAT_CONFIG_SCHEMA_UNSUPPORTED' });
}

/** Revalidate a host candidate synchronously without importing Cordis or running its hooks again. */
export function resolveRuntimeConfig(runtime, config) {
  if (!runtime?.Config) return config;
  const schema = runtime.Config['~standard'];
  if (!schema || schema.version !== 1 || typeof schema.validate !== 'function') {
    throw invalidSchema('A synchronous Standard Schema V1 config validator is required.');
  }
  const result = schema.validate(config);
  if (!result || typeof result !== 'object' || 'then' in result) {
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    throw invalidSchema('Async or malformed config validation is not supported.');
  }
  if (result.issues) {
    const error = Object.assign(new Error('Plugin configuration validation failed.'), {
      name: 'ValidationError', code: 'COMPAT_CONFIG_INVALID', issues: result.issues,
    });
    Object.defineProperty(error, Symbol.for('ValidationError'), { value: true });
    throw error;
  }
  if (!Object.hasOwn(result, 'value')) throw invalidSchema('The config validator returned no value.');
  return result.value;
}
