import { expect, test } from 'bun:test';
import { waveformAnalysisEnabled } from '../src/client/aria-audio.ts';

test('mobile devices skip waveform analysis, including iPad desktop mode', () => {
  for (const userAgent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/155.0.8059.37 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15',
    'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/155.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 16; Tablet) Chrome/155.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15'
  ]) {
    expect(waveformAnalysisEnabled({ userAgent, maxTouchPoints: 5 })).toBe(false);
  }
});

test('desktop devices keep waveform analysis, including touchscreen PCs', () => {
  for (const [userAgent, maxTouchPoints] of [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/155.0 Safari/537.36', 0],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0 Safari/537.36', 10],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/155.0 Safari/537.36', 0]
  ] as const) {
    expect(waveformAnalysisEnabled({ userAgent, maxTouchPoints })).toBe(true);
  }
});

test('a mobile browser hint enables the fallback even with a reduced user agent', () => {
  expect(
    waveformAnalysisEnabled({
      userAgent: 'Browser',
      maxTouchPoints: 0,
      userAgentData: { mobile: true }
    })
  ).toBe(false);
  expect(
    waveformAnalysisEnabled({
      userAgent: 'Browser',
      maxTouchPoints: 0,
      userAgentData: { mobile: false }
    })
  ).toBe(true);
});
