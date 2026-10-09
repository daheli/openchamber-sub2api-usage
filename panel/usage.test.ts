import { describe, expect, test } from 'bun:test';
import { readDailyCosts, reportingDay } from './usage';

const noCodexQuota = { ok: false, accountId: 6, error: 'admin-credentials-not-configured' };

describe('Sub2API daily charged cost', () => {
  test.each([0, 0.2463, '0.37877685'])('reads todayActualCost %s from the service response', value => {
    const body = JSON.stringify({ fetchedAt: 1, codex7d: noCodexQuota, results: [
      { id: 1, name: 'example-key-b', ok: true, todayActualCost: 84.9978 },
      { id: 2, name: 'example-key-a', ok: true, todayActualCost: value },
    ] });
    const parsed = readDailyCosts(body, [2, 1]);
    const result = parsed.results;
    expect(parsed.fetchedAt).toBe(1);
    expect(result.get(2)).toEqual({ value: Number(value), name: 'example-key-a' });
    expect(result.get(1)).toEqual({ value: 84.9978, name: 'example-key-b' });
  });
  test.each([null, '', ' ', 'NaN', 'Infinity', -1, true, [], {}].map(value => [value]))('rejects invalid cost %j', actual_cost => {
    const { results: result } = readDailyCosts(JSON.stringify({ fetchedAt: 1, codex7d: noCodexQuota, results: [
      { id: 1, name: 'example-key-a', ok: true, todayActualCost: 10 },
      { id: 2, name: 'example-key-b', ok: true, todayActualCost: actual_cost },
    ] }), [1, 2]);
    expect(result.get(1)).toEqual({ value: 10, name: 'example-key-a' });
    expect(result.get(2)).toEqual({ error: 'invalid-usage-data', name: 'example-key-b' });
  });
  test.each(['{}', '{', '{"error":"local-credentials-unavailable"}'])('rejects missing or invalid service responses', body => {
    expect(() => readDailyCosts(body, [1, 2])).toThrow();
  });
  test('does not confuse a swapped ID with the requested key', () => {
    expect(readDailyCosts(JSON.stringify({ fetchedAt: 1, codex7d: noCodexQuota, results: [
      { id: 2, name: 'example-key-b', ok: true, todayActualCost: 99 },
    ] }), [1, 2])).toEqual({ fetchedAt: 1, results: new Map([
      [1, { error: 'missing-key' }],
      [2, { value: 99, name: 'example-key-b' }],
    ]), codex7d: noCodexQuota });
  });
  test('missing selected keys do not become zero, unrelated keys are ignored', () => {
    const { results: result } = readDailyCosts(JSON.stringify({ fetchedAt: 1, codex7d: noCodexQuota, results: [
      { id: 1, name: 'example-key-a', ok: true, todayActualCost: 0 },
      { id: 17, name: 'other', ok: true, todayActualCost: 5 },
    ] }), [2, 1]);
    expect(result).toEqual(new Map([
      [2, { error: 'missing-key' }],
      [1, { value: 0, name: 'example-key-a' }],
    ]));
  });
  test('changes day at midnight Asia/Shanghai, not the machine timezone', () => {
    expect(reportingDay(new Date('2026-10-08T15:59:59Z'))).toBe('2026-10-08');
    expect(reportingDay(new Date('2026-10-08T16:00:00Z'))).toBe('2026-10-09');
  });

  test('parses Codex 7d utilization as a percentage, separate from key costs', () => {
    const parsed = readDailyCosts(JSON.stringify({ fetchedAt: 1, results: [], codex7d: {
      ok: true, accountId: 6, usedPercent: 42.75, resetsAt: null, updatedAt: '2026-10-09T00:00:00Z',
    } }), []);
    expect(parsed.codex7d).toEqual({
      ok: true, accountId: 6, usedPercent: 42.75, resetsAt: null, updatedAt: '2026-10-09T00:00:00Z',
    });
  });
});
