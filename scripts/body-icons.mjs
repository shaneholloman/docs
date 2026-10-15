import { createElement, BriefcaseBusiness, Layers, GraduationCap, FingerprintPattern, BookOpen, History } from 'lucide';
const headings = {
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
    const icon = createElement(node, {
      width: 16, height: 16,
      class: `lucide lucide-${name} cv-section-icon`,
      'data-lucide': name,
      'aria-hidden': 'true', focusable: 'false'
    });
    if (current) current.replaceWith(icon);
    else heading.prepend(icon);
  }
}
