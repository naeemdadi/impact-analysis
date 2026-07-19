/**
 * pnpm forwards the `--` argument separator to executable scripts. Normalize
 * it once so every project CLI accepts both direct and pnpm invocation forms.
 */
export function positionalArgs(argv = process.argv): string[] {
  const args = argv.slice(2);
  return args[0] === "--" ? args.slice(1) : args;
}

export function positiveIntegerArg(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
