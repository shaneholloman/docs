import {
  createElement,
  BriefcaseBusiness,
  Layers,
  GraduationCap,
  FingerprintPattern,
  BookOpen,
  History
} from 'lucide';
import type { IconNode } from 'lucide';
export type IconDefinition = [name: string, node: IconNode];
export function renderIcon([name, node]: IconDefinition, className = '') {
  return createElement(node, {
    class: `lucide lucide-${name}${className ? ` ${className}` : ''}`,
    'data-lucide': name,
    'aria-hidden': 'true',
    focusable: 'false'
  });
}
export function replaceIcon(svg: Element | null, definition: IconDefinition) {
  if (svg && svg.getAttribute('data-lucide') !== definition[0])
    svg.replaceWith(renderIcon(definition));
}
const headings: Record<string, IconDefinition> = {
  'profile-heading': ['fingerprint-pattern', FingerprintPattern],
  'experience-heading': ['briefcase-business', BriefcaseBusiness],
  'expertise-heading': ['layers', Layers],
  'learning-heading': ['book-open', BookOpen],
  'earlier-heading': ['history', History],
  'education-heading': ['graduation-cap', GraduationCap]
};
export function updateBodyIcons() {
  for (const [id, [name, node]] of Object.entries(headings)) {
    const heading = document.getElementById(id);
    if (!heading) continue;
    const current = heading.querySelector('.cv-section-icon');
    if (current?.getAttribute('data-lucide') === name) continue;
    const icon = renderIcon([name, node], 'cv-section-icon');
    if (current) current.replaceWith(icon);
    else heading.prepend(icon);
  }
}

export function setupThemeIcon() {
  // Mintlify generates raster favicons. Keep an SVG favicon synchronized with
  // the site's computed highlight color, using favicon.svg as the only source.
  async function initialize() {
    try {
      const response = await fetch('/favicon.svg');
      if (!response.ok) throw new Error(`Icon request failed: ${response.status}`);
      const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      if (svg.querySelector('parsererror')) throw new Error('Invalid icon SVG');
      let previousColor: string | undefined;
      let iconUrl = '';
      let frame = 0;

      function update() {
        const logo = document.querySelector('#navbar a:has(> .nav-logo)');
        if (!logo) return;
        const highlight = getComputedStyle(logo).getPropertyValue('--cv-accent').trim();
        if (highlight !== previousColor) {
          svg.documentElement.style.color = highlight;
          iconUrl = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          previousColor = highlight;
        }
        let icons = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
        if (!icons.length) {
          const icon = document.createElement('link');
          icon.rel = 'icon';
          document.head.append(icon);
          icons = [icon];
        }
        for (const icon of icons) {
          if (icon.getAttribute('href') === iconUrl) continue;
          icon.type = 'image/svg+xml';
          icon.sizes = 'any';
          icon.href = iconUrl;
        }
      }

      function scheduleUpdate() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      }

      new MutationObserver(scheduleUpdate).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      // Also handle favicon links replaced by client-side navigation.
      new MutationObserver(scheduleUpdate).observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
      });
      update();
    } catch (error) {
      console.warn('Unable to synchronize the theme icon:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
}
