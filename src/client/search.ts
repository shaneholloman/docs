export interface SearchEntry {
  title: string;
  context: string;
  text: string;
}
interface SectionEntry extends SearchEntry {
  element: HTMLElement;
}
interface SearchIcons {
  searchIcon: () => SVGElement;
  closeIcon: () => SVGElement;
  resultIcon: () => SVGElement;
}
const normalize = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function searchEntries<T extends SearchEntry>(entries: readonly T[], query: string): T[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return entries
    .map((entry, order) => {
      const title = normalize(entry.title);
      const context = normalize(entry.context);
      const text = normalize(entry.text);
      const score = terms.reduce(
        (total, term) => total + (title.includes(term) ? 10 : context.includes(term) ? 8 : 1),
        0
      );
      return {
        entry,
        order,
        score,
        matches: terms.every((term) => `${title} ${context} ${text}`.includes(term))
      };
    })
    .filter((result) => result.matches)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((result) => result.entry);
}

function collectEntries() {
  const entries: SectionEntry[] = [];
  const add = (
    element: HTMLElement | null,
    title: string | null | undefined,
    context: string,
    text = element?.textContent
  ) => {
    if (element?.id && title)
      entries.push({ element, title: title.trim(), context, text: text?.trim() || '' });
  };
  const profile = document.querySelector('.cv-profile');
  add(document.getElementById('profile-heading'), 'Profile', 'About Shane', profile?.textContent);
  for (const heading of document.querySelectorAll<HTMLElement>(
    '.cv-label:not(#profile-heading):not(#learning-heading)'
  )) {
    add(heading, heading.textContent, 'Section', heading.textContent);
  }
  for (const skill of document.querySelectorAll<HTMLElement>('.cv-skill')) {
    add(skill, skill.querySelector('h3')?.textContent, 'Expertise');
  }
  const studies = document.querySelector('.cv-learning');
  add(
    document.getElementById('learning-heading'),
    'Studies',
    'Courses and credentials',
    studies?.textContent
  );
  for (const job of document.querySelectorAll<HTMLElement>('.cv-job')) {
    add(
      job,
      job.querySelector('h3')?.textContent,
      `Experience • ${job.querySelector('.cv-job-meta > span')?.textContent}`
    );
  }
  for (const school of document.querySelectorAll<HTMLElement>('.cv-schools > div')) {
    add(
      school,
      school.querySelector('.cv-school-name')?.firstChild?.textContent,
      `Education • ${school.querySelector('.cv-school-detail')?.textContent?.trim()}`
    );
  }
  return entries;
}

export function setupSearch({ searchIcon, closeIcon, resultIcon }: SearchIcons) {
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let list: HTMLDivElement;
  let status: HTMLParagraphElement;
  let entries: SectionEntry[] = [];
  let results: SectionEntry[] = [];
  let active = 0;
  let returnFocus: HTMLElement | null;

  function select(entry: SectionEntry | undefined) {
    const target = entry && document.getElementById(entry.element.id);
    if (!target) return;
    returnFocus = null;
    dialog.close();
    target.tabIndex = -1;
    history.pushState(null, '', `#${target.id}`);
    requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
  }

  function setActive(index: number, scroll = false) {
    if (!results.length) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = (index + results.length) % results.length;
    for (const [i, option] of [...list.children].entries())
      option.setAttribute('aria-selected', String(i === active));
    input.setAttribute('aria-activedescendant', list.children[active].id);
    if (scroll) list.children[active].scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  function renderResults() {
    results = searchEntries(entries, input.value);
    list.replaceChildren(
      ...results.map((entry, index) => {
        const link = document.createElement('a');
        link.href = `#${entry.element.id}`;
        link.id = `cv-search-result-${index}`;
        link.setAttribute('role', 'option');
        link.tabIndex = -1;
        const copy = document.createElement('span');
        const title = document.createElement('span');
        title.className = 'cv-search-result-title';
        title.textContent = entry.title;
        const context = document.createElement('span');
        context.className = 'cv-search-result-context';
        context.textContent = entry.context;
        copy.append(title, context);
        link.append(copy, resultIcon());
        link.addEventListener('click', (event) => {
          event.preventDefault();
          select(entry);
        });
        return link;
      })
    );
    list.scrollTop = 0;
    status.textContent = results.length
      ? `${results.length} ${results.length === 1 ? 'result' : 'results'}`
      : 'No matching sections. Try a company, role, or skill.';
    setActive(0);
  }

  function createDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'cv-search-dialog';
    dialog.setAttribute('aria-label', 'Search CV');
    const field = document.createElement('div');
    field.className = 'cv-search-field';
    input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search CV';
    input.setAttribute('aria-label', 'Search CV');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'cv-search-results');
    input.setAttribute('aria-describedby', 'cv-search-help');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close search');
    close.append(closeIcon());
    close.addEventListener('click', () => dialog.close());
    field.append(searchIcon(), input, close);
    status = document.createElement('p');
    status.className = 'cv-search-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    list = document.createElement('div');
    list.id = 'cv-search-results';
    list.tabIndex = -1;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Matching CV sections');
    const help = document.createElement('p');
    help.id = 'cv-search-help';
    help.textContent = 'Use arrow keys to select, Enter to open, and Escape to close.';
    dialog.append(field, status, list, help);
    document.body.append(dialog);
    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dialog.close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(active + (event.key === 'ArrowDown' ? 1 : -1), true);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        select(results[active]);
      }
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === input) {
        event.preventDefault();
        close.focus();
      } else if (!event.shiftKey && document.activeElement === close) {
        event.preventDefault();
        input.focus();
      }
    });
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      )
        dialog.close();
    });
    dialog.addEventListener('close', () => {
      returnFocus?.focus({ preventScroll: true });
    });
  }

  function open() {
    if (!document.querySelector('.cv')) return;
    if (!dialog) createDialog();
    if (dialog.open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    entries = collectEntries();
    input.value = '';
    renderResults();
    dialog.showModal();
    input.focus();
  }

  document.addEventListener(
    'click',
    (event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(
          '.cv-header-search, .navbar-link a[href$="#cv-search"], #search-bar-entry, #search-bar-entry-mobile'
        )
      )
        return;
      if (!document.querySelector('.cv')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
    },
    true
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        document.querySelector('.cv')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        open();
      }
    },
    true
  );
}
