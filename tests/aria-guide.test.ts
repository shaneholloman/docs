import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openAriaGuide } from '../src/server/aria-guide.ts';
import { loadKnowledge } from '../src/server/aria-knowledge.ts';
import { askLuna } from '../src/server/aria-openai.ts';

const directory = dirname(fileURLToPath(import.meta.resolve('@shane/aria-guide/package.json')));
const resultSchema = z.object({
  ok: z.boolean(),
  mode: z.string(),
  page: z
    .object({ slug: z.string(), content: z.string().optional(), related: z.array(z.string()) })
    .optional(),
  readback: z
    .object({
      items: z.array(z.object({ slug: z.string(), title: z.string() }).passthrough()),
      page: z.object({ hasNext: z.boolean(), nextCursor: z.string().nullable() })
    })
    .optional()
});

test('the native Guide engine browses, searches, reads, resolves references and follows its cursors', () => {
  const guide = openAriaGuide(directory);
  try {
    expect(guide.count).toBeGreaterThan(100);
    expect(guide.lookup.tools.map((tool) => tool.name)).toEqual(['AriaQuery']);
    const execute = (args: unknown) =>
      resultSchema.parse(JSON.parse(guide.lookup.execute('AriaQuery', args)));
    const overview = execute({ mode: 'overview', page_size: 2 });
    expect(overview.readback?.items.map((item) => item.slug)).toEqual(['orientation', 'concepts']);
    const next = execute({
      mode: 'overview',
      page_size: 2,
      page_cursor: overview.readback?.page.nextCursor
    });
    expect(next.readback?.items[0].slug).toBe('foundations');
    const section = execute({ mode: 'section', section: 'primitives', page_size: 2 });
    expect(section.readback?.items.length).toBe(2);
    expect(section.readback?.page.hasNext).toBe(true);
    const found = execute({ mode: 'search', query: 'voice realtime delegation' });
    expect(found.readback?.items.some((item) => item.slug.includes('voice'))).toBe(true);
    const reference = execute({
      mode: 'reference',
      reference_kind: 'primitive',
      reference_id: 'voice'
    });
    expect(reference.page?.slug).toBe('primitive-voice');
    expect(reference.page?.content).toContain('WebRTC');
    expect(reference.page?.content).not.toContain('## Source References');
    expect(reference.page?.content).not.toContain('{{#if dev}}');
    const intro = execute({ mode: 'page', page: 'orientation-getting-started' });
    expect(intro.ok).toBe(true);
    expect(intro.page?.content).toContain('Aria');
    expect(execute({ mode: 'page', page: 'unknown-page' }).ok).toBe(false);
    expect(() => execute({ mode: 'page', page: 'primitive-voice', path: '/etc/passwd' })).toThrow();
    expect(() =>
      execute({ mode: 'search', query: 'voice', page_cursor: overview.readback?.page.nextCursor })
    ).toThrow();
  } finally {
    guide.close();
  }
});

test('Luna receives the two scoped query tools and uses the native Guide result in its Responses loop', async () => {
  const guide = openAriaGuide(directory);
  try {
    const material = await loadKnowledge('index.mdx', undefined, guide.lookup, 'knowledge');
    expect(material.lookup.tools.map((tool) => tool.name)).toEqual(['KnowledgeQuery', 'AriaQuery']);
    expect(
      JSON.parse(
        material.lookup.execute('KnowledgeQuery', { mode: 'page', page: 'background/shane.md' })
      ).page.content
    ).toContain('entire Aria harness');
    let round = 0;
    const request: typeof fetch = Object.assign(
      async (_url: unknown, options?: RequestInit) => {
        const body = JSON.parse(String(options?.body));
        expect(body.instructions).toContain('Prefer reference mode');
        expect(body.instructions).toContain('Tell me more about the Aria platform');
        expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
          'KnowledgeQuery',
          'AriaQuery'
        ]);
        if (++round === 1)
          return new Response(
            'data: ' +
              JSON.stringify({
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'guide-intro',
                      name: 'AriaQuery',
                      arguments: '{"mode":"page","page":"orientation-getting-started"}'
                    }
                  ]
                }
              }) +
              '\n\n'
          );
        const output = body.input.find(
          (item: { call_id?: string; type: string }) =>
            item.type === 'function_call_output' && item.call_id === 'guide-intro'
        );
        expect(JSON.parse(output.output).page.slug).toBe('orientation-getting-started');
        return new Response(
          'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'Aria is an agent platform built by Shane.' }
                    ]
                  }
                ]
              }
            }) +
            '\n\n'
        );
      },
      { preconnect: fetch.preconnect }
    );
    const answer = await askLuna(
      {
        prompt: 'Tell me more about the Aria platform',
        knowledge: material.text,
        lookup: material.lookup
      },
      request,
      async () => ({ token: 'offline-guide-test' })
    );
    expect(answer).toContain('agent platform');
    expect(round).toBe(2);
  } finally {
    guide.close();
  }
});
