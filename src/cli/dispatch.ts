/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * — once it lands — the per-session DB poller (container caller) call
 * dispatch() with the same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `safe` commands run inline.
 */
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { lookup } from './registry.js';

export async function dispatch(
  req: RequestFrame,
  ctx: CallerContext,
): Promise<ResponseFrame> {
  const cmd = lookup(req.command);
  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  // Agent + risky → approval flow. Wired alongside the first risky command;
  // until then, return a clear pending-shaped error so the contract is visible.
  if (ctx.caller !== 'host' && cmd.riskClass !== 'safe') {
    return err(
      req.id,
      'approval-pending',
      'Approval flow not yet wired. (Will be added when the first risky command lands.)',
    );
  }

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    const data = await cmd.handler(parsed, ctx);
    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
