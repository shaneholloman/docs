import test from 'node:test';
import assert from 'node:assert/strict';
import { searchEntries } from '../src/client/search.ts';

const entries = [
  { title: 'Profile', context: 'About Shane', text: 'Previously worked at Kordia and 8i.' },
  {
    title: 'Senior DevOps Engineer',
    context: 'Experience • Kordia Ltd',
    text: 'VMware, containers, and Ansible.'
  },
  {
    title: 'Infrastructure & DevOps',
    context: 'Expertise',
    text: 'Linux, automation, Ansible, and cloud-init.'
  },
  {
    title: 'IT Manager & DevOps Systems Engineer',
    context: 'Experience • 8i Ltd',
    text: 'Photogrammetry, Ansible, and bare-metal render farms.'
  }
];

test('company matches rank ahead of profile mentions', () => {
  assert.deepEqual(
    searchEntries(entries, 'Kordia').map((e) => e.title),
    ['Senior DevOps Engineer', 'Profile']
  );
});
test('multiple query terms can match a role and its company', () => {
  assert.deepEqual(
    searchEntries(entries, '8i DevOps').map((e) => e.context),
    ['Experience • 8i Ltd']
  );
});
test('skills return all relevant entries with title matches first', () => {
  assert.equal(searchEntries(entries, 'DevOps')[0].title, 'Senior DevOps Engineer');
  assert.equal(searchEntries(entries, 'Ansible').length, 3);
});
test('search normalizes case, accents, punctuation, and whitespace', () => {
  assert.deepEqual(searchEntries(entries, '  KÓRDIA!  '), searchEntries(entries, 'kordia'));
  assert.equal(searchEntries(entries, 'bare metal')[0].context, 'Experience • 8i Ltd');
});
test('empty queries preserve content order and unmatched queries return no results', () => {
  assert.deepEqual(searchEntries(entries, '  '), entries);
  assert.deepEqual(searchEntries(entries, 'nonexistent'), []);
});
