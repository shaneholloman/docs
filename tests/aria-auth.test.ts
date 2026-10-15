import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionReader } from '../src/server/aria-auth.ts';

test('dedicated NAS login refreshes once, persists rotation privately and survives a new process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aria-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'auth.json');
  const token = (exp: number) =>
    `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  const expired = token(1),
    fresh = token(Math.floor(Date.now() / 1000) + 3600);
  await writeFile(
    file,
    JSON.stringify({
      tokens: { access_token: expired, refresh_token: 'old-refresh', account_id: 'account' }
    })
  );
  let requests = 0;
  const read = subscriptionReader({
    file,
    refresh: true,
    request: async (url, options) => {
      requests++;
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert.ok(options.body instanceof URLSearchParams);
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      return Response.json({ access_token: fresh, refresh_token: 'rotated-refresh' });
    }
  });
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(requests, 1);
  assert.ok(results.every((result) => result.token === fresh));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tokens.refresh_token, 'rotated-refresh');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await subscriptionReader({ file })()).token, fresh);
  await writeFile(
    file,
    JSON.stringify({ tokens: { access_token: expired, refresh_token: 'old-refresh' } })
  );
  await assert.rejects(subscriptionReader({ file })(), /Sign in/);
  assert.equal(requests, 1);
});
