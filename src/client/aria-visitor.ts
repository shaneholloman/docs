const key = 'aria.hasSpoken';

/** A local welcome preference, not caller identification or conversation memory. */
export function createVisitorMemory(
  storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
) {
  let returning = false;
  try {
    returning = storage().getItem(key) === '1';
  } catch {
    /* Voice still works when browser storage is unavailable. */
  }
  return {
    get returning() {
      return returning;
    },
    connected() {
      returning = true;
      try {
        storage().setItem(key, '1');
      } catch {
        /* Remember repeat calls in this page even without persistent storage. */
      }
    }
  };
}
