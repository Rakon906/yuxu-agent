import { loadWechatGroups, additionalParticipationEnvironment, ensureAdditionalPeopleConfig,
  parseGroupWorkerArgs } from '../packages/wechat-adapter/group-config.mjs';
import { projectRoot } from './runtime.mjs';

const groupId = parseGroupWorkerArgs(process.argv.slice(2));
const config = loadWechatGroups(projectRoot);
const environment = additionalParticipationEnvironment(config, groupId, process.env);
ensureAdditionalPeopleConfig(config, groupId);
Object.assign(process.env, environment);
// Preserve the command-line identity in the OS while giving the imported worker
// its established argument contract. Each instance owns a different ledger.
process.argv = process.argv.slice(0, 2);
await import('./participation-worker.mjs');
