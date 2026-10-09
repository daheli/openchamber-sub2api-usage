import { z } from 'zod';

const cost = z.union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number().finite().nonnegative());
const serviceResultBase = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  ok: z.boolean(),
  error: z.enum(['credential-rejected', 'upstream-error', 'invalid-usage-data', 'timeout', 'request-failed']).optional(),
});
const serviceResult = serviceResultBase.extend({ todayActualCost: z.unknown().optional() });
const serviceResponse = z.object({ results: z.array(z.unknown()) });

// Parse selected entries independently. A missing or malformed key must not
// erase another key's valid reading or silently turn into zero usage.
export type DailyCostResult = { value: number; name: string } | { error: string; name?: string };

export function readDailyCosts(body: string, ids: readonly number[]): Map<number, DailyCostResult> {
  const parsed = serviceResponse.parse(JSON.parse(body));
  const byId = new Map<number, z.infer<typeof serviceResult>>();
  for (const entry of parsed.results) {
    const row = serviceResult.safeParse(entry);
    if (row.success) byId.set(row.data.id, row.data);
  }

  const results = new Map<number, DailyCostResult>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || !row.ok) {
      results.set(id, { error: row?.error ?? 'missing-key', ...(row ? { name: row.name } : {}) });
      continue;
    }
    const todayActualCost = cost.safeParse(row.todayActualCost);
    if (!todayActualCost.success) {
      results.set(id, { error: 'invalid-usage-data', name: row.name });
      continue;
    }
    results.set(id, { value: todayActualCost.data, name: row.name });
  }
  return results;
}

export const reportingDay = (date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
