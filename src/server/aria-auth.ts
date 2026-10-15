import { readFile, writeFile, rename } from 'node:fs/promises';
import {
  subscriptionSchema,
  tokenClaimsSchema,
  refreshedTokensSchema
} from '../shared/aria-contracts.ts';
import type { Subscription } from '../shared/aria-contracts.ts';

export function subscriptionReader({
  file,
  refresh = false,
  request = fetch
}: {
  file: string;
  refresh?: boolean;
  request?: (url: string, options: RequestInit) => Promise<Response>;
}) {
  let refreshing: Promise<Subscription> | undefined;
  const loginError = () =>
    new Error(
      'Sign in with ChatGPT on the Aria server using codex login --device-auth, then try again.'
    );
  const read = async () => {
    let auth;
    try {
      auth = subscriptionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      throw loginError();
    }
    if (!auth.tokens?.access_token || auth.auth_mode === 'apikey') throw loginError();
    let claims;
    try {
      claims = tokenClaimsSchema.parse(
        JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString())
      );
    } catch {
      throw loginError();
    }
    if (
      claims.exp &&
      claims.exp * 1000 <= Date.now() + 300_000 &&
      refresh &&
      auth.tokens.refresh_token
    ) {
      // Dedicated NAS credentials have one writer. Do not rotate the Mac's shared login.
      const response = await request('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: auth.tokens.refresh_token,
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw loginError();
      }
      const parsed = refreshedTokensSchema.safeParse(await response.json());
      if (!parsed.success) throw loginError();
      const next = parsed.data;
      for (const key of ['access_token', 'refresh_token', 'id_token'] as const)
        if (typeof next[key] === 'string') auth.tokens[key] = next[key];
      auth.last_refresh = new Date().toISOString();
      const temporary = `${file}.aria-tmp`;
      await writeFile(temporary, JSON.stringify(auth), { mode: 0o600 });
      await rename(temporary, file);
      claims = tokenClaimsSchema.parse(
        JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString())
      );
    }
    if (claims.exp && claims.exp * 1000 <= Date.now()) throw loginError();
    return {
      token: auth.tokens.access_token,
      accountId: auth.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id
    };
  };
  return () => {
    if (!refreshing)
      refreshing = read().finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
}
