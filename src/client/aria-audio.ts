// WebKit 326286: iOS 27 voice processing crackles during simultaneous playback.
// Keep this workaround version-scoped so other devices retain echo cancellation.
// https://bugs.webkit.org/show_bug.cgi?id=326286
export function captureConstraints(userAgent: string): MediaTrackConstraints {
  const ios = /\b(?:iPhone|iPad|iPod)\b|\bMacintosh\b.*\bMobile\b/.test(userAgent);
  const affected = ios && /\b(?:OS 27[_.]|Version\/27\.)/.test(userAgent);
  return {
    channelCount: 1,
    echoCancellation: !affected,
    noiseSuppression: !affected,
    autoGainControl: !affected
  };
}
