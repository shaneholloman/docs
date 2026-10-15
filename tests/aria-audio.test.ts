import { test, expect } from 'bun:test';
import { captureConstraints } from '../src/client/aria-audio.ts';

test('iOS 27 avoids the crackling voice-processing path without changing other platforms', () => {
  for (const agent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/144.0.0.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'
  ]) {
    expect(captureConstraints(agent)).toEqual({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    });
  }
  for (const agent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 Version/26.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 28_0 like Mac OS X) AppleWebKit/605.1.15 Version/28.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36'
  ]) {
    expect(captureConstraints(agent).echoCancellation).toBe(true);
  }
});
