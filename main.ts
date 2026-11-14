// main.ts — the entry <-> env lifecycle: bind an ephemeral port, tell the env which
// port it is, then poll until the env says the trial is over and exit 0. The suite
// scores the server app.ts builds; this file is the harness's handshake, so the
// behaviour below is the contract and must not change, only the wording around it.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial
//      container). Without it there is nothing to talk to, so exit 1 at once.
//   2. Build the server and listen(0): the kernel picks a free port. Never bind
//      8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the
//      request came from plus N as the base URL and dials it from then on. The first
//      register wins; a 409 means another entry already registered, and this process
//      keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at
//      once ({"done": false} while the suite runs), so this is a poll, not a
//      long-held request. A failed or slow poll is retried with a short exponential
//      backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no
// model call.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const CALL_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `tryNo` failed requests: exponential from RETRY_FIRST_MS, capped. */
function backoffFor(tryNo: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** Math.min(tryNo, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means
 * a first register already won, which is not this process's to fix. 400 and 405 are
 * contract errors and end the program; a network error or another status is retried,
 * since the env may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let tryNo = 0; ; tryNo += 1) {
    let reply: Response;
    try {
      reply = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout: the env may still be starting, so retry.
      await pause(backoffFor(tryNo));
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
    await pause(backoffFor(tryNo));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let tryNo = 0; ; tryNo += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffFor(tryNo));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });
  const bound = app.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  app.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (failure) {
  process.stderr.write(`[entry] ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exit(1);
}
