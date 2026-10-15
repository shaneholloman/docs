// Native Aria's Voice response, with the same constants and equations.
export function voiceLevel(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  return amplitudeLevel(rms);
}
export function amplitudeLevel(rms: number): number {
  if (!Number.isFinite(rms)) return 0;
  const normalized = Math.max(0, Math.min(1, (rms - 0.01) / (0.14 - 0.01)));
  return Math.pow(normalized, 0.62);
}

interface AudioStats {
  id: string;
  type: string;
  kind?: string;
  mediaType?: string;
  audioLevel?: number;
  totalAudioEnergy?: number;
  totalSamplesDuration?: number;
}

// Read existing WebRTC measurements without opening another audio device/graph.
export function createAudioStatsMeter() {
  const previous = new Map<string, { energy: number; duration: number; rms: number }>();
  return {
    read(report: Iterable<AudioStats>) {
      const levels = { visitor: 0, voice: 0 };
      for (const stat of report) {
        if ((stat.kind ?? stat.mediaType) !== 'audio') continue;
        const part =
          stat.type === 'media-source' ? 'visitor' : stat.type === 'inbound-rtp' ? 'voice' : null;
        if (!part) continue;
        let rms = stat.audioLevel ?? 0;
        const energy = stat.totalAudioEnergy,
          duration = stat.totalSamplesDuration;
        if (energy !== undefined && duration !== undefined) {
          const last = previous.get(stat.id);
          if (stat.audioLevel === undefined && last) {
            if (duration > last.duration && energy >= last.energy)
              rms = Math.sqrt((energy - last.energy) / (duration - last.duration));
            else if (duration === last.duration && energy === last.energy) rms = last.rms;
          }
          previous.set(stat.id, { energy, duration, rms });
        }
        levels[part] = Math.max(levels[part], amplitudeLevel(rms));
      }
      return levels;
    },
    reset() {
      previous.clear();
    }
  };
}
export function followEnvelope(current: number, target: number, elapsed: number): number {
  const timeConstant = target > current ? 45 : 260;
  return current + (target - current) * (1 - Math.exp(-elapsed / timeConstant));
}
export function backgroundPulse(impulse: number, magnitude = 1): number {
  const energy = Math.min(0.64, 0.2 + Math.log2(Math.max(1, magnitude) + 1) * 0.065);
  return Math.min(1, impulse + energy);
}
export function strokeBrightness(level: number): number {
  return Math.round(84 + (245 - 84) * level) / 245;
}
