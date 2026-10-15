import {
  CodeXml,
  ContactRound,
  Mail,
  Monitor,
  Sun,
  Moon,
  EllipsisVertical,
  X,
  ArrowUpRight,
  ChevronRight,
  ArrowUp,
  Check,
  Search,
  Mic,
  MicOff,
  PhoneOff
} from 'lucide';
import { setupSearch } from './search.ts';
import { updateBodyIcons, setupThemeIcon, renderIcon, replaceIcon } from './icons.ts';
import type { IconDefinition } from './icons.ts';
import { setupAria } from './aria-voice.ts';

const icons: Record<string, IconDefinition> = {
  'https://github.com/shaneholloman': ['code-xml', CodeXml],
  'https://www.linkedin.com/in/shaneholloman': ['contact-round', ContactRound],
  'mailto:shaneholloman@gmail.com': ['mail', Mail]
};
const themes: Record<string, IconDefinition> = {
  system: ['monitor', Monitor],
  light: ['sun', Sun],
  dark: ['moon', Moon]
};
type ThemePreference = 'system' | 'light' | 'dark';

function updateMobileThemes() {
  for (const menu of document.querySelectorAll('nav[aria-label="Mobile menu"]')) {
    const popover = menu.closest('[role="dialog"]');
    if (!popover) continue;
    popover.setAttribute('aria-label', 'Site navigation');
    let group = popover.querySelector<HTMLElement>('.cv-mobile-themes');
    if (!group) {
      group = document.createElement('div');
      group.className = 'cv-mobile-themes';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Theme preference');
      for (const preference of ['system', 'light', 'dark'] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.themeChoice = preference;
        const label = `${preference[0].toUpperCase()}${preference.slice(1)} theme`;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.append(renderIcon(themes[preference]));
        button.addEventListener('click', () => setThemePreference(preference));
        group.append(button);
      }
      popover.insertBefore(group, menu);
    }
    const selected = document.documentElement.getAttribute('data-theme-preference') || 'system';
    for (const button of group.querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === selected));
  }
}

function setThemePreference(preference: ThemePreference) {
  // Use Mintlify's persisted preference and storage listener so its theme
  // provider, desktop control, OS preference, and reloads stay synchronized.
  localStorage.setItem('isDarkMode', preference);
  window.dispatchEvent(new StorageEvent('storage', { key: 'isDarkMode', newValue: preference }));
}

const updateAriaHeader = setupAria({
  icon: (name) =>
    renderIcon([
      name,
      {
        x: X,
        mic: Mic,
        'mic-off': MicOff,
        'phone-off': PhoneOff,
        'chevron-right': ChevronRight
      }[name]
    ])
});

function updateHeader() {
  updateMobileThemes();
  updateBodyIcons();
  for (const link of document.querySelectorAll('.navbar-link a[href$="#cv-search"]')) {
    link.classList.add('cv-header-search');
    link.setAttribute('aria-label', 'Open search');
    link.setAttribute('title', 'Search');
  }
  updateAriaHeader();
  const mobileSearch = document.getElementById('search-bar-entry-mobile');
  if (mobileSearch) {
    mobileSearch.setAttribute('title', 'Search');
    replaceIcon(mobileSearch.querySelector('svg'), ['search', Search]);
  }
  const home = document.querySelector('#navbar a:has(> .nav-logo)');
  if (home) {
    home.setAttribute('href', '#top');
    home.setAttribute('aria-label', 'Back to top');
    home.setAttribute('title', 'Back to top');
  }
  for (const link of document.querySelectorAll('.navbar-link a')) {
    const href = link.getAttribute('href') || '';
    const url = new URL(href, location.href);
    if (['#cv-search', '#cv-aria'].includes(url.hash)) {
      link.removeAttribute('target');
      link.removeAttribute('rel');
    } else if (url.hash && document.getElementById(url.hash.slice(1))) {
      if (link.getAttribute('href') !== url.hash) link.setAttribute('href', url.hash);
      link.removeAttribute('target');
      link.removeAttribute('rel');
    } else if (icons[href]) {
      const label = link.textContent?.trim() || '';
      link.setAttribute('aria-label', label);
      link.setAttribute('title', label);
      link.classList.add('cv-header-icon');
      if (!link.querySelector('svg')) {
        link.prepend(renderIcon(icons[href]));
      }
    }
  }

  for (const wrapper of document.querySelectorAll('[data-theme-preference-icon]')) {
    const definition = themes[wrapper.getAttribute('data-theme-preference-icon') || ''];
    if (definition) replaceIcon(wrapper.querySelector('svg'), definition);
  }
  replaceIcon(document.querySelector('button[aria-label="More actions"] svg'), [
    'ellipsis-vertical',
    EllipsisVertical
  ]);
  for (const button of document.querySelectorAll('[role="dialog"] button')) {
    if (button.textContent.trim() === 'Close') replaceIcon(button.querySelector('svg'), ['x', X]);
  }
  for (const item of document.querySelectorAll('[role="menuitem"]')) {
    const theme = item.textContent?.trim().split(/\s+/)[0].toLowerCase() || '';
    if (themes[theme]) {
      const svgs = item.querySelectorAll('svg');
      replaceIcon(svgs[0], themes[theme]);
      if (svgs.length > 1) replaceIcon(svgs[svgs.length - 1], ['check', Check]);
    }
  }
  for (const span of document.querySelectorAll('.cv span[aria-hidden="true"]')) {
    const arrows: Record<string, IconDefinition> = {
      '↗': ['arrow-up-right', ArrowUpRight],
      '↑': ['arrow-up', ArrowUp]
    };
    const definition = arrows[span.textContent?.trim() || ''];
    if (definition && !span.querySelector('svg')) {
      span.replaceChildren(renderIcon(definition));
      span.classList.add('cv-inline-icon');
    }
  }
}

setupThemeIcon();
document.addEventListener(
  'click',
  (event) => {
    const link =
      event.target instanceof Element
        ? event.target.closest('nav[aria-label="Mobile menu"] a')
        : null;
    link?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('button')?.click();
  },
  true
);
setupSearch({
  searchIcon: () => renderIcon(['search', Search]),
  closeIcon: () => renderIcon(['x', X]),
  resultIcon: () => renderIcon(['chevron-right', ChevronRight])
});
updateHeader();
new MutationObserver(updateHeader).observe(document.body, { childList: true, subtree: true });
new MutationObserver(updateMobileThemes).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme-preference']
});
