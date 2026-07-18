// CSV formula-injection guard: a cell opened in a spreadsheet application (Excel, Google Sheets,
// LibreOffice) whose value starts with `=`, `+`, `-`, `@`, a tab, or a carriage return can be
// interpreted as a formula rather than plain text -- a classic CSV injection vector when the file
// contains attacker-controlled strings (e.g. a worker or company name). `guardCell` neutralizes
// this on export by prefixing a single `'` (the spreadsheet convention for "force text"), and
// `unguardCell` reverses it on import so the round-trip property still holds.

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Prefixes `value` with `'` if its first character would be interpreted as a formula trigger by
 * a spreadsheet application. Leaves every other value untouched. */
export function guardCell(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGER_CHARS.has(value[0] as string)) {
    return `'${value}`;
  }
  return value;
}

/** Inverse of `guardCell`. Only strips a leading `'` when the character right after it is itself
 * a formula-trigger character -- i.e. only when that `'` could only have come from `guardCell` --
 * so a legitimate value that happens to start with an apostrophe (e.g. "'Twas the night") is never
 * corrupted. */
export function unguardCell(value: string): string {
  if (value.length > 1 && value[0] === "'" && FORMULA_TRIGGER_CHARS.has(value[1] as string)) {
    return value.slice(1);
  }
  return value;
}
