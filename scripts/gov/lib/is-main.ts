/**
 * True when this module matches a script path argument in process.argv.
 * Works under both:
 *   - `bun script.ts` (argv[1] = full path; import.meta.url matches)
 *   - `bunx hardhat run script.ts ...` (argv[3] = "scripts/foo.ts"; import.meta.url ends with that)
 */
export function isMainScript(importMetaUrl: string): boolean {
  return process.argv.some((arg) => {
    if (!arg || arg.startsWith("-")) return false;
    const normalized = arg.replace(/^\.\//, "");
    return importMetaUrl.endsWith(normalized);
  });
}
