import { getAllAgentGroups } from '../../db/agent-groups.js';
import { register } from '../registry.js';

register({
  name: 'list-groups',
  description: 'List all agent groups.',
  riskClass: 'safe',
  parseArgs: () => ({}),
  handler: async () =>
    getAllAgentGroups().map((g) => ({
      id: g.id,
      name: g.name,
      folder: g.folder,
      provider: g.agent_provider ?? 'claude',
      created_at: g.created_at,
    })),
});
