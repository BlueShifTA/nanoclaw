import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  DRIFT_THRESHOLD_MS,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { loadDriftState, saveDriftState } from './drift-state.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessages,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let lastAgentOutput: Record<string, { time: number; text: string }> = {};
let containerStartTime: Record<string, number> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  const driftState = loadDriftState();
  lastAgentOutput = driftState.lastAgentOutput;
  containerStartTime = driftState.containerStartTime;
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  containerStartTime[chatJid] = Date.now();
  saveDriftState({ lastAgentOutput, containerStartTime });
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        lastAgentOutput[chatJid] = {
          time: Date.now(),
          text: text.slice(0, 120),
        };
        saveDriftState({ lastAgentOutput, containerStartTime });
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  function humanDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // Handle /ping — instant orchestrator health check + optional agent status
  async function handlePing(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = queue.getStatus(chatJid);
    const sessionId = sessions[group.folder];
    const lastActivity = lastAgentTimestamp[chatJid];
    const now = Date.now();

    let agentLine: string;
    let driftWarning = '';

    if (status.active && status.isTaskContainer) {
      const runningFor = containerStartTime[chatJid]
        ? humanDuration(now - containerStartTime[chatJid])
        : 'unknown';
      agentLine = `Agent: running scheduled task (${runningFor})`;
    } else if (status.active && status.idleWaiting) {
      agentLine = `Agent: idle (container alive, waiting for input)`;
    } else if (status.active) {
      const runningFor = containerStartTime[chatJid]
        ? humanDuration(now - containerStartTime[chatJid])
        : 'unknown';
      const lastOut = lastAgentOutput[chatJid];
      const silentFor = lastOut
        ? now - lastOut.time
        : containerStartTime[chatJid]
          ? now - containerStartTime[chatJid]
          : null;

      agentLine = `Agent: processing (running ${runningFor})`;

      if (silentFor !== null && silentFor > DRIFT_THRESHOLD_MS) {
        driftWarning = `⚠️ Possible drift — silent for ${humanDuration(silentFor)}. Use /kill to force-stop or /reset to recover.`;
      } else if (silentFor !== null) {
        agentLine += `, last output ${humanDuration(silentFor)} ago`;
      }
    } else {
      agentLine = `Agent: idle (no active container)`;
    }

    const sessionLine = sessionId
      ? `Session: ${sessionId.slice(0, 8)}…`
      : `Session: none`;
    const activityLine = lastActivity
      ? `Last activity: ${new Date(lastActivity).toLocaleString('en-CH', { timeZone: TIMEZONE })}`
      : `Last activity: none`;

    const lastOut = lastAgentOutput[chatJid];
    const lastOutputLine = lastOut
      ? `Last output: "${lastOut.text.replace(/\n/g, ' ')}${lastOut.text.length >= 120 ? '…' : ''}"`
      : null;

    const lines = [`NanoClaw alive`, agentLine, sessionLine, activityLine];
    if (lastOutputLine) lines.push(lastOutputLine);
    if (driftWarning) lines.push(driftWarning);

    await channel.sendMessage(chatJid, lines.join('\n'));

    // If a container is active and not drifted, ask the agent for a brief status.
    // Queued in IPC — agent responds after current work, never interrupts.
    if (status.active && !status.isTaskContainer && !driftWarning) {
      const pingPrompt =
        `[ping] Briefly summarise what you're currently doing or just finished ` +
        `(1–2 sentences max), then continue your work uninterrupted.`;
      queue.sendMessage(chatJid, pingPrompt);
      logger.debug({ group: group.name }, 'Ping forwarded to active agent');
    }
  }

  // Handle /last [n] — show last N bot responses from DB (default 1)
  async function handleLast(chatJid: string, arg: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const n = Math.min(Math.max(parseInt(arg) || 1, 1), 10);
    const msgs = getLastBotMessages(chatJid, n);

    if (msgs.length === 0) {
      await channel.sendMessage(chatJid, 'No agent responses found.');
      return;
    }

    const lines = msgs.map((m, i) => {
      const time = new Date(m.timestamp).toLocaleString('en-CH', {
        timeZone: TIMEZONE,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const prefix = msgs.length > 1 ? `[${i + 1}] ${time}\n` : `${time}\n`;
      return prefix + m.content;
    });

    await channel.sendMessage(chatJid, lines.join('\n\n---\n'));
  }

  // Handle /kill — force-stop a stuck/drifted container
  async function handleKill(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = queue.getStatus(chatJid);
    if (!status.active) {
      await channel.sendMessage(chatJid, 'No active container to kill.');
      return;
    }

    const killed = queue.kill(chatJid);
    if (killed) {
      logger.info({ group: group.name }, 'Container force-killed via /kill');
      await channel.sendMessage(
        chatJid,
        `Container killed. Session preserved — use /reset if you want a fresh start.`,
      );
    } else {
      await channel.sendMessage(
        chatJid,
        'Kill failed — container may have already exited.',
      );
    }
  }

  // Handle /reset — summarise session to journal + memory, then clear
  async function handleReset(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Capture session ID now — must stay intact while runAgent uses it
    const sessionIdForSummary = sessions[group.folder];

    if (!sessionIdForSummary) {
      // Nothing to summarise — just clear state
      lastAgentTimestamp[chatJid] = new Date().toISOString();
      saveState();
      await channel.sendMessage(
        chatJid,
        'No active session to summarise. State cleared.',
      );
      return;
    }

    await channel.sendMessage(chatJid, 'Summarising session before reset...');

    // Hard-kill any active container so it doesn't write concurrently
    // while we summarise. Fall back to closeStdin if no containerName yet.
    if (!queue.kill(chatJid)) queue.closeStdin(chatJid);

    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const summarisePrompt = `Before this session is reset, do the following in order:

1. **Write a journal entry** to \`/workspace/extra/armlab/journal/${now}.md\` (create the directory if needed) with:
   - Date/time header
   - Summary of everything discussed and decided in this session
   - Any tasks completed, in-progress, or pending
   - Important context, decisions, or open questions

2. **Update persistent memory** in \`/workspace/group/CLAUDE.md\` by appending a brief "## Session ${now}" section with:
   - Key facts or decisions that should be remembered in future sessions
   - Any client/project status updates worth retaining
   - Skip anything already in the file

3. Reply with a short confirmation of what you saved (2–3 sentences max).

Do NOT do anything else. This is a pre-reset snapshot.`;

    // Always use runAgent (awaited) so journal is fully written before we clear.
    // Session ID is still intact at this point so the agent has full history.
    await channel.setTyping?.(chatJid, true);
    await runAgent(group, summarisePrompt, chatJid, async (result) => {
      if (result.result) {
        const text =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const clean = text
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (clean) await channel.sendMessage(chatJid, clean);
      }
    });
    await channel.setTyping?.(chatJid, false);

    // Only now — after summary is complete — clear the session
    delete sessions[group.folder];
    deleteSession(group.folder);
    delete lastAgentOutput[chatJid];
    delete containerStartTime[chatJid];
    saveDriftState({ lastAgentOutput, containerStartTime });

    // Advance cursor so old messages are not replayed
    lastAgentTimestamp[chatJid] = new Date().toISOString();
    saveState();

    logger.info({ group: group.name }, 'Session reset via /reset command');
    await channel.sendMessage(
      chatJid,
      'Session cleared. Ready for a fresh start.',
    );
  }

  // Handle /compact — compact context of the current session
  async function handleCompact(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Guard: no point compacting if there's no existing session to compact
    if (!sessions[group.folder]) {
      await channel.sendMessage(chatJid, 'No active session to compact.');
      return;
    }

    // If a container is active, pipe /compact directly to it
    if (queue.sendMessage(chatJid, '/compact')) {
      logger.info({ group: group.name }, 'Piped /compact to active container');
      return;
    }

    // No active container — resume existing session and run /compact
    logger.info({ group: group.name }, 'Running /compact in new container');
    await channel.setTyping?.(chatJid, true);
    await runAgent(group, '/compact', chatJid, async (result) => {
      if (result.result) {
        const text =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const clean = text
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (clean) await channel.sendMessage(chatJid, clean);
      }
    });
    await channel.setTyping?.(chatJid, false);
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // /ping — instant health check, answered by orchestrator directly
      if (trimmed === '/ping') {
        if (!registeredGroups[chatJid]) return;
        handlePing(chatJid).catch((err) =>
          logger.error({ err, chatJid }, '/ping command error'),
        );
        return;
      }

      // /last [n] — show last N messages from DB
      if (trimmed.startsWith('/last')) {
        if (!registeredGroups[chatJid]) return;
        const arg = trimmed.slice(5).trim();
        handleLast(chatJid, arg).catch((err) =>
          logger.error({ err, chatJid }, '/last command error'),
        );
        return;
      }

      // Session management commands — intercept before storage
      if (
        trimmed === '/reset' ||
        trimmed === '/compact' ||
        trimmed === '/kill'
      ) {
        if (!registeredGroups[chatJid]) return;
        if (trimmed === '/reset') {
          handleReset(chatJid).catch((err) =>
            logger.error({ err, chatJid }, '/reset command error'),
          );
        } else if (trimmed === '/compact') {
          handleCompact(chatJid).catch((err) =>
            logger.error({ err, chatJid }, '/compact command error'),
          );
        } else {
          handleKill(chatJid).catch((err) =>
            logger.error({ err, chatJid }, '/kill command error'),
          );
        }
        return;
      }

      // /btw <note> — inject context into active container or queue for next run
      // No trigger required; agent acknowledges only if relevant.
      if (trimmed.startsWith('/btw ') || trimmed === '/btw') {
        if (!registeredGroups[chatJid]) return;
        const note = trimmed.slice(5).trim();
        if (!note) return;
        const btwText = `[btw — side note, no response needed unless relevant]: ${note}`;
        if (queue.sendMessage(chatJid, btwText)) {
          // Piped into active container; don't store separately
          logger.debug({ chatJid }, '/btw piped to active container');
        } else {
          // No active container — store as a regular message so it becomes
          // context on the next agent run (bypasses trigger requirement below)
          storeMessage({ ...msg, content: btwText });
          lastAgentTimestamp[chatJid] = lastAgentTimestamp[chatJid] || '';
        }
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendMedia: async (jid, filePath, filename, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendMedia) {
        await channel.sendMedia(jid, { filePath, filename, caption });
      } else if (caption) {
        // Fallback for channels without media support
        await channel.sendMessage(jid, caption);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
