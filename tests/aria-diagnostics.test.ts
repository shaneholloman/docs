import { test, expect } from 'bun:test';
import { audioDiagnosticsEnabled, summarizeAudioStats } from '../src/client/aria-diagnostics.ts';

test('diagnostics require explicit URL opt-in on every supported host', () => {
  for (const origin of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://aria.shaneholloman.dev',
    'https://shaneholloman.dev'
  ]) {
    expect(audioDiagnosticsEnabled(origin, '')).toBe(false);
    expect(audioDiagnosticsEnabled(origin, '?aria-audio-test=0')).toBe(false);
    expect(audioDiagnosticsEnabled(origin, '?aria-audio-test=1')).toBe(true);
  }
  expect(
    audioDiagnosticsEnabled('https://aria.shaneholloman.dev.example', '?aria-audio-test=1')
  ).toBe(false);
});

test('transport reports retain audio degradation counters and selected codec without private fields', () => {
  const report = new Map([
    [
      'audio',
      {
        type: 'inbound-rtp',
        kind: 'audio',
        codecId: 'opus',
        packetsLost: 3,
        concealedSamples: 480,
        insertedSamplesForDeceleration: 96,
        address: 'private',
        deviceId: 'private'
      }
    ],
    ['video', { type: 'inbound-rtp', kind: 'video', packetsLost: 999 }],
    [
      'opus',
      { type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdp: 'private' }
    ],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        type: 'candidate-pair',
        currentRoundTripTime: 0.02,
        localCandidateId: 'private',
        address: 'private'
      }
    ]
  ]);
  const result = summarizeAudioStats(report as unknown as RTCStatsReport);
  expect(result.metrics).toEqual([
    {
      type: 'inbound-rtp',
      packetsLost: 3,
      concealedSamples: 480,
      insertedSamplesForDeceleration: 96
    },
    { type: 'candidate-pair', currentRoundTripTime: 0.02 }
  ]);
  expect(result.codecs).toEqual([{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }]);
  expect(JSON.stringify(result)).not.toContain('private');
});

test('unsupported audio metrics remain absent rather than being reported as zero', () => {
  const report = new Map([['audio', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 20 }]]);
  const result = summarizeAudioStats(report as unknown as RTCStatsReport);
  expect(result.metrics[0]?.packetsReceived).toBe(20);
  expect(result.metrics[0]?.concealedSamples).toBeUndefined();
});
