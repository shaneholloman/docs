type AudioDevice = Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & {
  userAgentData?: { mobile?: boolean };
};

/** Keep mobile playback free of the Web Audio metering context for now. */
export function waveformAnalysisEnabled(device: AudioDevice): boolean {
  const mobile =
    device.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent) ||
    (device.maxTouchPoints > 1 && /Macintosh/i.test(device.userAgent));
  return !mobile;
}
