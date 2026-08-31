/**
 * The two coercions every tolerant reader of stored or imported settings makes.
 *
 * One definition each, because there were three `record`-shaped copies across
 * `settings.ts`, `settings-import.ts` and `fakefiller-migrate.ts` — two of them
 * identical, the third rejecting arrays — and near-identical coercions with
 * divergent edges are the risky kind of duplication: a fix to one quietly
 * misses the others. The strict form won: an array is not a settings record,
 * and treating one as `Record<string, unknown>` invites numeric keys into code
 * that expects names.
 */

/**
 * A record, or `{}` — never an array, never null. The tolerant reader's
 * outermost step: whatever a file or a store holds under a name, the reader
 * sees a record and every missing key falls back.
 */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A list-valued key, or an empty list — a file may put anything under any name. */
export function listAt(value: Record<string, unknown>, key: string): readonly unknown[] {
  const list = value[key];
  return Array.isArray(list) ? list : [];
}
