import { expect, test } from 'bun:test';
import { createVisitorMemory } from '../src/client/aria-visitor.ts';

test('a successful call enables the welcome-back preference across page loads', () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  });
  const first = createVisitorMemory(storage);
  expect(first.returning).toBe(false);
  expect(createVisitorMemory(storage).returning).toBe(false);
  first.connected();
  expect(first.returning).toBe(true);
  expect(createVisitorMemory(storage).returning).toBe(true);
  expect(createVisitorMemory(storage).id).toBe(first.id);
  expect([...data]).toEqual([['aria.visitorId', first.id]]);
  expect(first.id).toMatch(/^[a-f0-9-]{36}$/);
  data.clear();
  expect(createVisitorMemory(storage).returning).toBe(false);
  expect(createVisitorMemory(storage).id).not.toBe(first.id);
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

test('forgetting removes the saved identity and legacy hint, and idle tabs start fresh', () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  });
  const visitor = createVisitorMemory(storage);
  visitor.connected();
  data.set('aria.hasSpoken', '1');
  const idleTab = createVisitorMemory(storage);
  const previousId = visitor.id;
  visitor.forget();
  expect(data.size).toBe(0);
  expect(visitor.id).not.toBe(previousId);
  expect(visitor.returning).toBe(false);
  expect(idleTab.id).not.toBe(previousId);
  expect(idleTab.returning).toBe(false);
  const freshId = visitor.id;
  visitor.connected();
  expect(visitor.id).toBe(freshId);
  expect(data.get('aria.visitorId')).toBe(freshId);
  expect(idleTab.id).toBe(freshId);
  expect(idleTab.returning).toBe(true);
});

test('forgetting still resets the identity when storage is blocked', () => {
  const visitor = createVisitorMemory(() => {
    throw new Error('Storage blocked');
  });
  visitor.connected();
  const oldId = visitor.id;
  visitor.forget();
  expect(visitor.returning).toBe(false);
  expect(visitor.id).not.toBe(oldId);
});
