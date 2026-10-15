import { z } from 'zod';

const number = z.number().finite().optional();
// Explicit allowlist: never include SDP, candidate addresses, device identifiers,
// credentials, audio samples, or transcripts in a diagnostic report.
const metricSchema = z.object({
  type: z.string(),
  timestamp: number,
  packetsReceived: number,
  packetsSent: number,
  packetsLost: number,
  packetsDiscarded: number,
  jitter: number,
  jitterBufferDelay: number,
  jitterBufferTargetDelay: number,
  jitterBufferMinimumDelay: number,
  jitterBufferEmittedCount: number,
  totalSamplesReceived: number,
  concealedSamples: number,
  silentConcealedSamples: number,
  concealmentEvents: number,
  insertedSamplesForDeceleration: number,
  removedSamplesForAcceleration: number,
  currentRoundTripTime: number,
  roundTripTime: number,
  synthesizedSamplesDuration: number,
  synthesizedSamplesEvents: number,
  totalSamplesDuration: number,
  totalPlayoutDelay: number
});
const codecSchema = z.object({
  mimeType: z.string(),
  clockRate: number,
  channels: number
});
const identitySchema = z.object({
  type: z.string(),
  kind: z.string().optional(),
  mediaType: z.string().optional(),
  codecId: z.string().optional(),
  selectedCandidatePairId: z.string().optional()
});

export function audioDiagnosticsEnabled(origin: string, search: string) {
  const url = new URL(origin);
  const allowed =
    ['https://aria.shaneholloman.dev', 'https://shaneholloman.dev'].includes(url.origin) ||
    ['localhost', '127.0.0.1'].includes(url.hostname);
  return allowed && new URLSearchParams(search).get('aria-audio-test') === '1';
}

export function summarizeAudioStats(report: RTCStatsReport) {
  const metrics: z.infer<typeof metricSchema>[] = [];
  const codecs: z.infer<typeof codecSchema>[] = [];
  const seenCodecs = new Set<string>();
  for (const value of report.values()) {
    const identity = identitySchema.safeParse(value);
    if (!identity.success) continue;
    const item = identity.data;
    if (item.type === 'transport' && item.selectedCandidatePairId) {
      const pair = metricSchema.safeParse(report.get(item.selectedCandidatePairId));
      if (pair.success) metrics.push(pair.data);
    }
    if (
      !['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'media-playout'].includes(item.type) ||
      (item.kind || item.mediaType) !== 'audio'
    )
      continue;
    const metric = metricSchema.safeParse(value);
    if (metric.success) metrics.push(metric.data);
    if (item.codecId && !seenCodecs.has(item.codecId)) {
      seenCodecs.add(item.codecId);
      const codec = codecSchema.safeParse(report.get(item.codecId));
      if (codec.success) codecs.push(codec.data);
    }
  }
  return { metrics, codecs };
}

interface AudioCall {
  peer: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
}

export function createAudioDiagnostics() {
  let context: AudioContext | undefined;
  let call: AudioCall | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let started = 0;
  let summary: HTMLParagraphElement | undefined;
  let pause: HTMLButtonElement | undefined;
  let reportField: HTMLTextAreaElement | undefined;
  let baseline: HTMLInputElement | undefined;
  const samples: unknown[] = [];
  const events: { elapsedMs: number; action: string }[] = [];
  let latest: ReturnType<typeof summarizeAudioStats> | undefined;
  const elapsed = () => Math.round(performance.now() - started);
  function reportText() {
    return JSON.stringify({ version: 1, browser: navigator.userAgent, events, samples }, null, 2);
  }
  function update() {
    if (!summary || !pause) return;
    pause.disabled = !context || context.state === 'closed';
    pause.textContent = context?.state === 'suspended' ? 'Resume analyser' : 'Pause analyser';
    const inbound = latest?.metrics.find((item) => item.type === 'inbound-rtp');
    const value = (metric: number | undefined) => metric ?? 'unavailable';
    summary.textContent = call
      ? `Analyser: ${context?.state || 'not started'} • Packets lost: ${value(inbound?.packetsLost)} • Concealed samples: ${value(inbound?.concealedSamples)} • Slowed samples: ${value(inbound?.insertedSamplesForDeceleration)}`
      : samples.length
        ? 'Call ended. The report remains available.'
        : 'Start a voice call to collect measurements.';
  }
  async function collect(current: AudioCall, currentRevision: number) {
    try {
      const stats = summarizeAudioStats(await current.peer.getStats());
      if (call !== current || revision !== currentRevision) return;
      latest = stats;
      const settings = current.stream.getAudioTracks()[0]?.getSettings();
      samples.push({
        elapsedMs: elapsed(),
        ...stats,
        capture: {
          sampleRate: settings?.sampleRate,
          channelCount: settings?.channelCount,
          echoCancellation: settings?.echoCancellation,
          noiseSuppression: settings?.noiseSuppression,
          autoGainControl: settings?.autoGainControl
        },
        analyser: context
          ? {
              state: context.state,
              sampleRate: context.sampleRate,
              currentTime: context.currentTime,
              baseLatency: context.baseLatency,
              outputLatency: context.outputLatency
            }
          : null,
        playback: {
          paused: current.audio.paused,
          playbackRate: current.audio.playbackRate,
          readyState: current.audio.readyState
        }
      });
      if (samples.length > 300) samples.shift();
      update();
    } catch {
      if (call === current && revision === currentRevision)
        events.push({ elapsedMs: elapsed(), action: 'Stats unavailable' });
    } finally {
      if (call === current && revision === currentRevision)
        timer = setTimeout(() => void collect(current, currentRevision), 1000);
    }
  }
  return {
    skipAnalysis: () => Boolean(baseline?.checked),
    observeContext(value: AudioContext | undefined) {
      context = value;
      update();
    },
    start(value: AudioCall) {
      clearTimeout(timer);
      call = value;
      const currentRevision = ++revision;
      samples.length = 0;
      events.length = 0;
      latest = undefined;
      started = performance.now();
      events.push({ elapsedMs: 0, action: 'Call started' });
      if (baseline) {
        baseline.disabled = true;
        if (baseline.checked) events.push({ elapsedMs: 0, action: 'No analyser baseline' });
      }
      if (reportField) reportField.hidden = true;
      update();
      void collect(value, currentRevision);
    },
    end() {
      if (call) events.push({ elapsedMs: elapsed(), action: 'Call ended' });
      call = undefined;
      revision++;
      clearTimeout(timer);
      if (baseline) baseline.disabled = false;
      update();
    },
    attach(parent: HTMLElement, before: HTMLElement) {
      const details = document.createElement('details');
      details.className = 'cv-aria-diagnostics';
      const title = document.createElement('summary');
      title.textContent = 'Audio diagnostic';
      const note = document.createElement('p');
      note.textContent =
        'Test only. Pausing freezes rings; voice stays connected. Reports stay here and contain no audio.';
      summary = document.createElement('p');
      const baselineLabel = document.createElement('label');
      baseline = document.createElement('input');
      baseline.type = 'checkbox';
      baselineLabel.append(baseline, document.createTextNode(' Start next call without analyser'));
      const actions = document.createElement('div');
      actions.className = 'cv-aria-diagnostic-actions';
      pause = document.createElement('button');
      pause.type = 'button';
      pause.addEventListener('click', async () => {
        const current = context;
        if (!current || current.state === 'closed' || !pause) return;
        pause.disabled = true;
        try {
          const action = current.state === 'running' ? 'suspend' : 'resume';
          await current[action]();
          if (current === context && call)
            events.push({ elapsedMs: elapsed(), action: `Analyser ${action}` });
        } catch {
          if (summary) summary.textContent = 'The browser could not change analyser state.';
        }
        update();
      });
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.textContent = 'Mark crackle';
      mark.addEventListener('click', () => {
        if (call) events.push({ elapsedMs: elapsed(), action: 'Crackle heard' });
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy report';
      reportField = document.createElement('textarea');
      reportField.readOnly = true;
      reportField.rows = 5;
      reportField.hidden = true;
      reportField.setAttribute('aria-label', 'Audio diagnostic report');
      copy.addEventListener('click', async () => {
        const text = reportText();
        try {
          if (!navigator.clipboard) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Report copied';
        } catch {
          if (!reportField) return;
          reportField.value = text;
          reportField.hidden = false;
          reportField.focus();
          reportField.select();
        }
      });
      actions.append(pause, mark, copy);
      details.append(title, note, baselineLabel, summary, actions, reportField);
      parent.insertBefore(details, before);
      update();
    }
  };
}
