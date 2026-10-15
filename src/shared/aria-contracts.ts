import { z } from 'zod';

export const voiceNames = [
  'cove',
  'juniper',
  'maple',
  'spruce',
  'ember',
  'vale',
  'breeze',
  'arbor',
  'sol'
] as const;
export const askRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2000),
  sessionId: z.uuid().optional()
});
export const sessionRequestSchema = z.strictObject({
  sdp: z.string().startsWith('v=0').max(100_000),
  voice: z.enum(voiceNames).optional(),
  returning: z.boolean().optional()
});
export const searchArgumentsSchema = z.strictObject({ query: z.string().trim().min(1).max(300) });
export const readArgumentsSchema = z.strictObject({ source: z.string().min(1).max(255) });
export const subscriptionSchema = z
  .object({
    auth_mode: z.string().optional(),
    tokens: z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().optional(),
        account_id: z.string().optional(),
        id_token: z.string().optional()
      })
      .passthrough(),
    last_refresh: z.string().optional()
  })
  .passthrough();
export const tokenClaimsSchema = z.object({
  exp: z.number().optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional()
});
export const refreshedTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional()
});
export const ariaEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('aria.activity'), magnitude: z.number().min(1).max(100000) }),
  z.object({
    type: z.literal('aria.caption'),
    role: z.enum(['user', 'assistant']),
    delta: z.string(),
    timestamp: z.number()
  }),
  z.object({ type: z.literal('aria.error'), message: z.string() }),
  z.object({ type: z.literal('aria.closed'), reason: z.literal('completed').optional() }),
  z.object({
    type: z.enum([
      'aria.thinking',
      'aria.ready',
      'aria.ending',
      'aria.turn.done',
      'session.started',
      'session.closed',
      'output_audio_buffer.started',
      'output_audio_buffer.stopped'
    ])
  })
]);
export type AriaEvent = z.infer<typeof ariaEventSchema>;
export type Subscription = { token: string; accountId?: string };
export type VoiceName = (typeof voiceNames)[number];
export const statusSchema = z.object({
  authenticated: z.boolean(),
  message: z.string().optional(),
  sources: z.number(),
  voices: z.array(z.enum(voiceNames))
});
export const sessionResultSchema = z.object({ id: z.uuid(), sdp: z.string().startsWith('v=') });
export const answerResultSchema = z.object({ answer: z.string() });
export const textEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('aria.activity'), magnitude: z.number().min(1).max(100000) }),
  z.object({ type: z.literal('aria.answer'), answer: z.string() }),
  z.object({ type: z.literal('aria.error'), message: z.string() })
]);
export const errorResultSchema = z.object({ error: z.string() });
export const responseItemSchema = z
  .object({
    type: z.string(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
      .optional()
  })
  .passthrough();
export type ResponseItem = z.infer<typeof responseItemSchema>;
export const responseStreamEventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  response: z.object({ status: z.string(), output: z.array(responseItemSchema) }).optional()
});
export const liveEventSchema = z.object({
  type: z.string(),
  item: z
    .object({
      target: z.string().optional(),
      id: z.string().optional(),
      text: z.string().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional()
    })
    .optional(),
  turn: z.object({ role: z.string().optional() }).optional(),
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
      type: z.string().optional()
    })
    .optional()
});
export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}
export interface KnowledgeLookup {
  tools: FunctionTool[];
  execute: (name: string, args: unknown) => string;
}
export interface KnowledgeMaterial {
  text: string;
  count: number;
  lookup: KnowledgeLookup;
}
export interface AskInput {
  prompt: string;
  knowledge: string;
  history?: ResponseItem[];
  signal?: AbortSignal;
  sessionId?: string;
  lookup?: KnowledgeLookup;
  onTool?: (name: string, args: unknown) => void;
  onActivity?: (magnitude: number) => void;
}
export interface VoiceConnection {
  answerSdp: string;
  sessionId: string;
  deliver: (id: string, text: string) => void;
  speak: (text: string) => void;
  close: () => void;
}
export interface VoiceInput {
  sdp: string;
  knowledge: string;
  voice?: VoiceName;
  returning?: boolean;
  signal?: AbortSignal;
  onEvent: (event: AriaEvent) => void;
  onDelegation: (id: string, prompt: string) => Promise<void>;
  onClose: () => void;
}
