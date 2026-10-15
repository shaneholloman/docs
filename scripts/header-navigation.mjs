import {
  createElement, CodeXml, ContactRound, Mail, Monitor, Sun, Moon,
  EllipsisVertical, X, ArrowUpRight, ArrowUp, Check, Search
} from 'lucide';

const icons = {
  'https://github.com/shaneholloman': ['code-xml', CodeXml],
  'https://www.linkedin.com/in/shaneholloman': ['contact-round', ContactRound],
  'mailto:shaneholloman@gmail.com': ['mail', Mail]
};
const themes = {
  system: ['monitor', Monitor],
  light: ['sun', Sun],
  dark: ['moon', Moon]
};
const mobileLinks = new WeakSet();

function renderIcon([name, node]) {
  return createElement(node, {
    class: `lucide lucide-${name}`,
    'data-lucide': name,
    'aria-hidden': 'true',
    focusable: 'false'
  });
}

function replaceIcon(svg, definition) {
  if (svg && svg.getAttribute('data-lucide') !== definition[0]) {
    svg.replaceWith(renderIcon(definition));
  }
}

function updateHeader() {
  const navigation = document.querySelector('#navbar nav[aria-label="Main"] > ul');
  if (navigation && !navigation.querySelector('.cv-search-item')) {
    const item = document.createElement('li');
    item.className = 'cv-search-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cv-header-search';
    button.setAttribute('aria-label', 'Open search');
    button.setAttribute('title', 'Search');
    button.append(renderIcon(['search', Search]));
    button.addEventListener('click', () => document.getElementById('search-bar-entry')?.click());
    item.append(button);
    navigation.prepend(item);
  }
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
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.hash && document.getElementById(url.hash.slice(1))) {
      if (link.getAttribute('href') !== url.hash) link.setAttribute('href', url.hash);
      link.removeAttribute('target');
      link.removeAttribute('rel');
      if (link.closest('nav[aria-label="Mobile menu"]') && !mobileLinks.has(link)) {
        link.addEventListener('click', () => link.closest('[role="dialog"]')?.querySelector('button')?.click());
        mobileLinks.add(link);
      }
    } else if (icons[link.getAttribute('href')]) {
      const label = link.textContent.trim();
      link.setAttribute('aria-label', label);
      link.setAttribute('title', label);
      link.classList.add('cv-header-icon');
      if (!link.querySelector('svg')) {
        link.prepend(renderIcon(icons[link.getAttribute('href')]));
      }
    }
  }

  for (const wrapper of document.querySelectorAll('[data-theme-preference-icon]')) {
    const definition = themes[wrapper.getAttribute('data-theme-preference-icon')];
    if (definition) replaceIcon(wrapper.querySelector('svg'), definition);
  }
  replaceIcon(document.querySelector('button[aria-label="More actions"] svg'), ['ellipsis-vertical', EllipsisVertical]);
  for (const button of document.querySelectorAll('[role="dialog"] button')) {
    if (button.textContent.trim() === 'Close') replaceIcon(button.querySelector('svg'), ['x', X]);
  }
  for (const item of document.querySelectorAll('[role="menuitem"]')) {
    const theme = item.textContent.trim().split(/\s+/)[0].toLowerCase();
    if (themes[theme]) {
      const svgs = item.querySelectorAll('svg');
      replaceIcon(svgs[0], themes[theme]);
      if (svgs.length > 1) replaceIcon(svgs[svgs.length - 1], ['check', Check]);
    }
  }
  for (const span of document.querySelectorAll('.cv span[aria-hidden="true"]')) {
    const definition = { '↗': ['arrow-up-right', ArrowUpRight], '↑': ['arrow-up', ArrowUp] }[span.textContent.trim()];
    if (definition && !span.querySelector('svg')) {
      span.replaceChildren(renderIcon(definition));
      span.classList.add('cv-inline-icon');
    }
  }
}

updateHeader();
new MutationObserver(updateHeader).observe(document.body, { childList: true, subtree: true });
