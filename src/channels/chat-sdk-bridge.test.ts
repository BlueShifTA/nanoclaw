import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import type { ConversationConfig } from './adapter.js';
import { createChatSdkBridge, shouldEngage, type EngageSource } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

function cfg(
  partial: Partial<ConversationConfig> & { engageMode: ConversationConfig['engageMode'] },
): ConversationConfig {
  return {
    platformId: partial.platformId ?? 'C1',
    agentGroupId: partial.agentGroupId ?? 'ag-1',
    engageMode: partial.engageMode,
    engagePattern: partial.engagePattern ?? null,
    sessionMode: partial.sessionMode ?? 'shared',
  };
}

function mapFor(...configs: ConversationConfig[]): Map<string, ConversationConfig[]> {
  const map = new Map<string, ConversationConfig[]>();
  for (const c of configs) {
    const existing = map.get(c.platformId);
    if (existing) existing.push(c);
    else map.set(c.platformId, [c]);
  }
  return map;
}

describe('createChatSdkBridge', () => {
  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });
});

describe('shouldEngage', () => {
  describe('unknown conversation', () => {
    const empty = new Map<string, ConversationConfig[]>();
    const sources: EngageSource[] = ['subscribed', 'mention', 'dm'];
    for (const source of sources) {
      it(`forwards for source='${source}' (may be a not-yet-wired group)`, () => {
        expect(shouldEngage(empty, 'C1', source, '')).toEqual({ engage: true, stickySubscribe: false });
      });
    }
    it("DROPS for source='new-message' (would flood from unwired channels)", () => {
      expect(shouldEngage(empty, 'C1', 'new-message', 'hello')).toEqual({
        engage: false,
        stickySubscribe: false,
      });
    });
  });

  describe("engageMode='mention'", () => {
    const conv = mapFor(cfg({ engageMode: 'mention' }));
    it('engages on mention + dm', () => {
      expect(shouldEngage(conv, 'C1', 'mention', '').engage).toBe(true);
      expect(shouldEngage(conv, 'C1', 'dm', '').engage).toBe(true);
    });
    it('does NOT engage on subscribed or new-message (prevents keep-firing + flooding)', () => {
      expect(shouldEngage(conv, 'C1', 'subscribed', '').engage).toBe(false);
      expect(shouldEngage(conv, 'C1', 'new-message', '').engage).toBe(false);
    });
    it('never asks to subscribe', () => {
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, '').stickySubscribe).toBe(false);
      }
    });
  });

  describe("engageMode='mention-sticky'", () => {
    const conv = mapFor(cfg({ engageMode: 'mention-sticky' }));
    it('engages on mention + dm with stickySubscribe=true', () => {
      expect(shouldEngage(conv, 'C1', 'mention', '')).toEqual({ engage: true, stickySubscribe: true });
      expect(shouldEngage(conv, 'C1', 'dm', '')).toEqual({ engage: true, stickySubscribe: true });
    });
    it('engages on subscribed follow-ups without re-subscribing', () => {
      expect(shouldEngage(conv, 'C1', 'subscribed', '')).toEqual({ engage: true, stickySubscribe: false });
    });
    it('does NOT engage on new-message (explicit mention required to start)', () => {
      expect(shouldEngage(conv, 'C1', 'new-message', '').engage).toBe(false);
    });
  });

  describe("engageMode='pattern'", () => {
    it('pattern="." engages on every source except new-message-with-unknown', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '.' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'anything').engage).toBe(true);
      }
    });

    it('tests regex against text on new-message (the main bug fix)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '^!report' }));
      expect(shouldEngage(conv, 'C1', 'new-message', '!report now').engage).toBe(true);
      expect(shouldEngage(conv, 'C1', 'new-message', 'nothing to see').engage).toBe(false);
    });

    it('pattern regex applies on every source (symmetry)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: 'deploy' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'time to deploy').engage).toBe(true);
        expect(shouldEngage(conv, 'C1', s, 'weather today').engage).toBe(false);
      }
    });

    it('pattern never triggers sticky-subscribe', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '.' }));
      for (const s of ['subscribed', 'mention', 'dm', 'new-message'] as EngageSource[]) {
        expect(shouldEngage(conv, 'C1', s, 'hi').stickySubscribe).toBe(false);
      }
    });

    it('invalid regex fails open (admin sees something rather than silent drop)', () => {
      const conv = mapFor(cfg({ engageMode: 'pattern', engagePattern: '[unclosed' }));
      expect(shouldEngage(conv, 'C1', 'new-message', 'x').engage).toBe(true);
    });
  });

  describe('multiple wirings on one conversation', () => {
    it('takes the union across wirings (any-engage wins)', () => {
      // mention wiring + pattern wiring on the same channel. A plain message
      // should engage via the pattern wiring even though the mention wiring
      // alone would reject it.
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'pattern', engagePattern: '^hi' }),
      );
      expect(shouldEngage(conv, 'C1', 'new-message', 'hi there').engage).toBe(true);
      expect(shouldEngage(conv, 'C1', 'new-message', 'something else').engage).toBe(false);
    });

    it('stickySubscribe from any mention-sticky wiring wins', () => {
      const conv = mapFor(
        cfg({ agentGroupId: 'ag-a', engageMode: 'mention' }),
        cfg({ agentGroupId: 'ag-b', engageMode: 'mention-sticky' }),
      );
      expect(shouldEngage(conv, 'C1', 'mention', '')).toEqual({ engage: true, stickySubscribe: true });
    });
  });
});
