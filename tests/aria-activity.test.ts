import { test, expect } from 'bun:test';
import {
  voiceLevel,
  followEnvelope,
  backgroundPulse,
  strokeBrightness
} from '../src/shared/aria-activity.ts';

test('native speech metering ignores the noise floor and reaches full level at normal speech', () => {
  expect(voiceLevel(new Float32Array(256).fill(0.005))).toBe(0);
  expect(voiceLevel(new Float32Array(256).fill(0.14))).toBeCloseTo(1, 6);
  expect(voiceLevel(new Float32Array(256).fill(0.075))).toBeCloseTo(Math.pow(0.5, 0.62), 6);
});
test('native attack and release retain their timing regardless of frame subdivision', () => {
  expect(followEnvelope(0, 1, 45)).toBeCloseTo(1 - Math.exp(-1), 12);
  expect(followEnvelope(1, 0, 260)).toBeCloseTo(Math.exp(-1), 12);
  let subdivided = 0;
  for (let index = 0; index < 9; index++) subdivided = followEnvelope(subdivided, 1, 5);
  expect(subdivided).toBeCloseTo(followEnvelope(0, 1, 45), 12);
  expect(strokeBrightness(0)).toBe(84 / 245);
  expect(strokeBrightness(1)).toBe(1);
});
test('native background pulse accumulates with event magnitude and stays bounded', () => {
  expect(backgroundPulse(0, 1)).toBeCloseTo(0.265, 12);
  expect(backgroundPulse(0, 127)).toBeCloseTo(0.64, 12);
  expect(backgroundPulse(0.8, 127)).toBe(1);
});
