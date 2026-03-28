/**
 * Persists agent output timestamps to disk so drift detection survives
 * NanoClaw restarts. Without this, lastAgentOutput is zeroed on every restart
 * and a drifted agent looks healthy until it produces new output.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const STATE_PATH = path.join(DATA_DIR, 'drift-state.json');

export interface AgentOutputRecord {
  time: number; // epoch ms
  text: string; // truncated last output
}

export interface DriftState {
  lastAgentOutput: Record<string, AgentOutputRecord>;
  containerStartTime: Record<string, number>;
}

export function loadDriftState(): DriftState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8');
      return JSON.parse(raw) as DriftState;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load drift state, starting fresh');
  }
  return { lastAgentOutput: {}, containerStartTime: {} };
}

export function saveDriftState(state: DriftState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to save drift state');
  }
}
