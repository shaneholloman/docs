import { X, Mic, MicOff, PhoneOff, ChevronRight } from 'lucide';
import { renderIcon } from './icons.ts';
import { setupAria } from './aria-voice.ts';
import type { AriaIconName } from './aria-voice.ts';

const definitions: Record<AriaIconName, typeof X> = {
  x: X,
  mic: Mic,
  'mic-off': MicOff,
  'phone-off': PhoneOff,
  'chevron-right': ChevronRight
};
const update = setupAria({
  icon: (name) => renderIcon([name, definitions[name]])
});
// Mintlify hydrates the complete document. Wait for its own custom header
// script before inserting Aria, so server-rendered markup still matches React.
const afterHeader = () => {
  if (
    document.querySelector('.cv-header-search, #search-bar-entry-mobile svg[data-lucide="search"]')
  )
    update();
};
const observer = new MutationObserver(afterHeader);
observer.observe(document.body, { childList: true, subtree: true });
afterHeader();
