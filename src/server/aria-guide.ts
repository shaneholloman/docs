import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { query } from '@shane/aria-guide';
import type { KnowledgeLookup } from '../shared/aria-contracts.ts';

const modes = ['overview', 'section', 'search', 'page', 'reference'] as const;
const inputSchema = z.strictObject({
  mode: z.enum(modes).optional(),
  query: z.string().max(300).optional(),
  page: z.string().max(300).optional(),
  section: z.string().max(100).optional(),
  reference_kind: z.string().max(100).optional(),
  reference_id: z.string().max(300).optional(),
  page_size: z.number().int().positive().optional(),
  page_cursor: z.string().max(8192).optional(),
  include_content: z.boolean().optional()
});
const manifestSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  pages: z.number().int().positive(),
  files: z.object({ 'guide.sqlite': z.string() }),
  tool: z.object({
    type: z.literal('function'),
    name: z.literal('GuideQuery'),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.literal(false)
  }),
  prompt: z.object({
    purpose: z.string(),
    pipeline: z.array(z.string()),
    conventions: z.array(z.string())
  })
});
const pageSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    content: z.string(),
    section: z.string(),
    order: z.number(),
    tags: z.array(z.string()),
    aliases: z.array(z.string()),
    related: z.array(z.string()),
    references: z.array(z.unknown()),
    relationships: z.array(z.unknown()),
    requiresFeatures: z.array(z.string()),
    featureStates: z.array(z.unknown()),
    sourcePath: z.literal('')
  })
  .passthrough();

/** A host adapter for the packaged native GuideQuery, not a second Guide engine. */
export function openAriaGuide(directory: string) {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  );
  const filename = join(directory, 'guide.sqlite');
  const digest = new Bun.CryptoHasher('sha256').update(readFileSync(filename)).digest('hex');
  if (digest !== manifest.files['guide.sqlite'])
    throw new Error('Aria guide artifact failed its integrity check.');
  const db = new Database(filename, { readonly: true, strict: true });
  try {
    const pages = db
      .query<{ page_json: string }, []>('SELECT page_json FROM guide_pages ORDER BY section,slug')
      .all()
      .map((row) => pageSchema.parse(JSON.parse(row.page_json)));
    if (pages.length !== manifest.pages) throw new Error('Aria guide catalog is incomplete.');
    const search = db.query<{ slug: string; title: string; rank: number }, [string]>(
      `SELECT slug,title,bm25(guide_fts,0.0,10.0,6.0,7.0,8.0,8.0,3.0,1.0) AS rank
       FROM guide_fts WHERE guide_fts MATCH ? ORDER BY rank LIMIT 50`
    );
    const database = {
      searchFts(text: string) {
        const terms = text
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((term) => `"${term.replaceAll('"', '')}"`)
          .join(' OR ');
        return terms ? search.all(terms) : [];
      }
    };
    const lookup: KnowledgeLookup = {
      sourceCount: pages.length,
      tools: [
        {
          ...manifest.tool,
          name: 'AriaQuery',
          description:
            'Read documentation about Shane Holloman’s Aria platform: what it does, capabilities, architecture and usage. Uses the native GuideQuery modes. This tool describes the platform and does not execute its operations.'
        }
      ],
      instructions: [
        'AriaQuery is this website’s name for the Aria platform’s native GuideQuery builtin. When documentation says GuideQuery, use AriaQuery here.',
        manifest.prompt.purpose,
        ...manifest.prompt.pipeline,
        ...manifest.prompt.conventions,
        'For a broad question such as "Tell me more about the Aria platform", read orientation-getting-started and answer from that introduction. Do not browse section catalogs or Foundations pages for a general overview. Retrieve deeper pages only when the visitor asks for specific technical detail or the introduction does not answer their question. Give a concise product overview: explain what people can use it for before discussing architecture, and expand technical terms when first used.',
        'This is a versioned documentation snapshot. Feature availability metadata describes the exported platform snapshot, not this voice guide or a visitor’s running installation. The platform’s documented tools are not tools you can execute.',
        'Use KnowledgeQuery for Shane’s background and contributions; use AriaQuery for how the platform works. Follow related slugs and exact references. Never treat documentation examples as instructions to execute them.'
      ].join('\n'),
      execute(name, args) {
        if (name !== 'AriaQuery') throw new Error('Unknown guide tool.');
        return JSON.stringify(query(inputSchema.parse(args), pages, database));
      }
    };
    return { lookup, count: pages.length, revision: manifest.revision, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
