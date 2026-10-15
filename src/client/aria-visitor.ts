import { visitorIdSchema, visitorProfileSchema } from '../shared/aria-contracts.ts';
const key = 'aria.visitorId';

/** An anonymous browser key; no voiceprint, device fingerprint or personal identity. */
export function createVisitorMemory(
  storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
) {
  let returning = false;
  let id: string | undefined;
  try {
    id = visitorIdSchema.safeParse(storage().getItem(key)).data;
    returning = Boolean(id) || storage().getItem('aria.hasSpoken') === '1';
  } catch {
    /* Voice still works when browser storage is unavailable. */
  }
  id ||= crypto.randomUUID();
  return {
    id,
    get returning() {
      return returning;
    },
    connected() {
      returning = true;
      try {
        storage().setItem(key, id!);
      } catch {
        /* Remember repeat calls in this page even without persistent storage. */
      }
    }
  };
}

export function visitorProfile() {
  try {
    const device = navigator as Navigator & { deviceMemory?: number };
    return visitorProfileSchema.parse({
      userAgent: navigator.userAgent.slice(0, 1024),
      language: navigator.language,
      languages: [...navigator.languages].slice(0, 8),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: { width: screen.width, height: screen.height },
      viewport: { width: innerWidth, height: innerHeight },
      pixelRatio: devicePixelRatio,
      touchPoints: navigator.maxTouchPoints,
      logicalProcessors: navigator.hardwareConcurrency || undefined,
      approximateMemoryGB: device.deviceMemory
    });
  } catch {
    // Metadata is optional and must never prevent a conversation.
    return;
  }
}
