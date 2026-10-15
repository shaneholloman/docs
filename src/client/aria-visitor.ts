import { visitorIdSchema, visitorProfileSchema } from '../shared/aria-contracts.ts';
const key = 'aria.visitorId';

/** An anonymous browser key; no voiceprint, device fingerprint or personal identity. */
export function createVisitorMemory(
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = () => localStorage
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
  let persisted = false;
  try {
    persisted = storage().getItem(key) === id;
  } catch {
    /* Optional storage. */
  }
  function sync() {
    try {
      const saved = visitorIdSchema.safeParse(storage().getItem(key)).data;
      if (saved && saved !== id) {
        id = saved;
        returning = true;
        persisted = true;
      } else if (!saved && persisted) {
        id = crypto.randomUUID();
        returning = false;
        persisted = false;
      }
    } catch {
      /* Keep this page usable without storage. */
    }
  }
  return {
    get id() {
      sync();
      return id!;
    },
    get returning() {
      sync();
      return returning;
    },
    connected() {
      returning = true;
      try {
        storage().setItem(key, id!);
        persisted = true;
      } catch {
        /* Remember repeat calls in this page even without persistent storage. */
      }
    },
    forget() {
      try {
        if (storage().getItem(key) === id) storage().removeItem(key);
        storage().removeItem('aria.hasSpoken');
      } catch {
        /* Reset this page even when storage is blocked. */
      }
      id = crypto.randomUUID();
      returning = false;
      persisted = false;
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
