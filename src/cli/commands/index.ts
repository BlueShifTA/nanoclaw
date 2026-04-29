// Side-effect imports — each command file calls register() at top level.
// Imported by src/index.ts on host startup so the registry is populated
// before the CLI server accepts connections.
import './list-groups.js';
