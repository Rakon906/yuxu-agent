import { loadWechatGroups } from '../packages/wechat-adapter/group-config.mjs';
import { projectRoot } from './runtime.mjs';
if (process.argv.length !== 2) throw new Error('Group configuration takes no arguments');
console.log(JSON.stringify(loadWechatGroups(projectRoot)));
