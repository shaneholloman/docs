import { expect, test } from 'bun:test';
import { createVisitorMemory } from '../src/client/aria-visitor.ts';

test('a successful call enables the welcome-back preference across page loads', () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value)
  });
  const first = createVisitorMemory(storage);
  expect(first.returning).toBe(false);
  expect(createVisitorMemory(storage).returning).toBe(false);
  first.connected();
  expect(first.returning).toBe(true);
  expect(createVisitorMemory(storage).returning).toBe(true);
  expect([...data]).toEqual([['aria.hasSpoken', '1']]);
  data.clear();
  expect(createVisitorMemory(storage).returning).toBe(false);
});

test('blocked storage never prevents calls, and repeat calls still work within the page', () => {
  const storage = () => {
    throw new Error('Storage blocked');
  };
  const visitor = createVisitorMemory(storage);
  expect(visitor.returning).toBe(false);
  visitor.connected();
  expect(visitor.returning).toBe(true);
  expect(createVisitorMemory(storage).returning).toBe(false);
});
