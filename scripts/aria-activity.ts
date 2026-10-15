// Native Aria's Voice response, with the same constants and equations.
export function voiceLevel(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  const normalized = Math.max(0, Math.min(1, (rms - 0.01) / (0.14 - 0.01)));
  return Math.pow(normalized, 0.62);
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
