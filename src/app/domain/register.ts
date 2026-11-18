export interface RegVersion<V> { id: string; parents: string[]; hlc: string; value: V }
export interface RegisterState<V> {
  versions: RegVersion<V>[];
  heads: RegVersion<V>[];
  current: RegVersion<V> | undefined;
  conflict: boolean;
  /** Parents that are referenced but not (yet) present, e.g. events from another device not synced yet. */
  missingParents: string[];
}

const asc = <V>(a: RegVersion<V>, b: RegVersion<V>) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveRegister<V>(input: RegVersion<V>[], same: (a: V, b: V) => boolean): RegisterState<V> {
  const byId = new Map<string, RegVersion<V>>();
  for (const v of [...input].sort(asc)) if (!byId.has(v.id)) byId.set(v.id, v); // duplicate ids: the earliest wins, deterministically
  const versions = [...byId.values()];
  const referenced = new Set<string>();
  const missing = new Set<string>();
  for (const v of versions) for (const p of v.parents) (byId.has(p) ? referenced : missing).add(p);
  let heads = versions.filter((v) => !referenced.has(v.id));
  if (heads.length === 0 && versions.length > 0) heads = versions.slice(-1); // cycle safety (malformed data)
  const current = [...heads].sort((a, b) => -asc(a, b))[0];
  const conflict = current !== undefined && heads.some((h) => !same(h.value, current.value));
  return { versions, heads, current, conflict, missingParents: [...missing].sort() };
}
