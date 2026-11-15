// main.ts — the entrypoint and the env handshake. The suite scores the server
// app.ts builds; this file is only the lifecycle contract, and that contract is
// fixed, so only the wording and the helper shapes below are new:
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial
//      container). Without it there is nothing to talk to, so exit 1 at once.
//   2. Build the server and listen(0): the kernel picks a free port. Never bind
//      8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address
//      the request came from plus N as the base URL and dials it from then on.
//      The first register wins; a 409 means another entry already registered,
//      and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with a
//      short exponential backoff; the process never exits before the env says
//      done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in,
// no model call.
//
// Exit codes: 0 once the env says done, 1 on a contract error (missing env URL,
// register refused with 400/405, the server failing to bind). Retries never
// consume the process — a slow or restarting env is waited out, not fatal.

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_FIRST_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or another
 * status is retried, since the env may still be starting.
 */
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
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
      await sleep(retryDelay(attempt));
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });
  const bound = app.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  app.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (failure) {
  process.stderr.write(`[entry] ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exit(1);
}
