import { expect, test } from 'bun:test';
import { z } from 'zod';
import { connectVoice } from '../src/server/aria-openai.ts';
import { voiceGreeting } from '../src/server/aria-knowledge.ts';

const startupSchema = z.object({
  sdp: z.string(),
  session: z.object({
    instructions: z.string(),
    audio: z.object({ output: z.object({ voice: z.string() }) }),
    initial_items: z
      .array(
        z.object({
          type: z.literal('message'),
          role: z.literal('developer'),
          content: z.array(z.object({ type: z.literal('input_text'), text: z.string() })).length(1)
        })
      )
      .length(1)
  })
});

for (const returning of [false, true]) {
  test(`${returning ? 'returning' : 'new'} calls carry an immediate opening greeting in the subscription startup request`, async () => {
    const request: typeof fetch = Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = startupSchema.parse(JSON.parse(String(init?.body)));
        expect(body.session.audio.output.voice).toBe('cove');
        const greeting = body.session.initial_items[0].content[0].text;
        expect(greeting).toContain('Greet the caller now in English, before they speak');
        expect(greeting).toContain(voiceGreeting(returning));
        expect(greeting).toContain('once, then pause and listen');
        expect(body.session.instructions).toContain('Recalled history is from earlier calls');
        expect(body.session.instructions).toContain('The name is Shane by the way');
        expect(body.session.instructions).toContain('latest explicit statement or correction');
        // Stop at the HTTP boundary: no OpenAI request or real sideband is opened.
        return new Response('', { status: 400 });
      },
      { preconnect: fetch.preconnect }
    );
    await expect(
      connectVoice(
        {
          sdp: 'v=0\r\n',
          knowledge: '<resume>Shane Holloman</resume>',
          returning,
          history: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'The name is Shane by the way' }]
            }
          ],
          onEvent: () => {},
          onDelegation: async () => {},
          onClose: () => {}
        },
        request,
        async () => ({ token: 'offline-fixture' })
      )
    ).rejects.toThrow('HTTP 400');
  });
}
