const WALL = 15;
const CTR = 5;

export function parseHlc(h: string): { wall: number; counter: number } | null {
  const m = /^(\d{15})-(\d{5})-/.exec(h);
  return m ? { wall: Number(m[1]), counter: Number(m[2]) } : null;
}

export function nextHlc(prev: string | null, nowMs: number, deviceId: string): string {
  const p = prev ? parseHlc(prev) : null;
  const wall = Math.max(p?.wall ?? 0, nowMs);
  const counter = p && p.wall === wall ? p.counter + 1 : 0;
  return `${String(wall).padStart(WALL, '0')}-${String(counter).padStart(CTR, '0')}-${deviceId}`;
}

export function maxHlc(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}
