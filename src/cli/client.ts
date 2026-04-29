/**
 * `nc` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   nc <command> [--key value ...] [--json]
 *
 * Examples:
 *   nc list-groups
 *   nc list groups            # space-separated form is auto-joined
 *   nc list-groups --json
 */
import { randomUUID } from 'crypto';

import { formatResponse } from './format.js';
import type { RequestFrame } from './frame.js';
import { SocketTransport } from './socket-client.js';
import type { Transport } from './transport.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, args, json } = parseArgv(argv);
  const req: RequestFrame = { id: randomUUID(), command, args };
  const transport: Transport = pickTransport();

  let res;
  try {
    res = await transport.sendFrame(req);
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    process.exit(2);
  }

  process.stdout.write(formatResponse(res, json ? 'json' : 'human'));
  process.exit(res.ok ? 0 : 1);
}

function pickTransport(): Transport {
  // Container DB transport will land alongside the agent-runner change.
  // For now: host-only — the only callers are a shell user or Claude in
  // the project.
  return new SocketTransport();
}

function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stderr.write('nc: missing command\n');
    printUsage();
    process.exit(2);
  }

  // Allow `nc list groups` as well as `nc list-groups`. Server rejects
  // unknowns, so the naive join is safe — at worst the user gets an
  // unknown-command error.
  const command =
    positional.length >= 2 ? `${positional[0]}-${positional[1]}` : positional[0];

  return { command, args, json };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: nc <command> [--key value ...] [--json]',
      '',
      'Commands:',
      '  list-groups          List all agent groups.',
      '',
      'Run `nc <command> --json` for machine-readable output.',
      '',
    ].join('\n'),
  );
}

function formatTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
    return [
      `nc: cannot reach NanoClaw host (${msg}).`,
      `Is the host running? Start it with: pnpm run dev`,
      `Or, if installed as a service:`,
      `  macOS:  launchctl kickstart -k gui/$(id -u)/com.nanoclaw`,
      `  Linux:  systemctl --user restart nanoclaw`,
      ``,
    ].join('\n');
  }
  return `nc: transport error: ${msg}\n`;
}

main().catch((err) => {
  process.stderr.write(
    `nc: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});
