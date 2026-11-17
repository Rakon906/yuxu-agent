import { join } from 'node:path';
import { projectRoot } from './runtime.mjs';
import { probeNativeMoments } from '../packages/moments/native-probe.mjs';
const result = await probeNativeMoments({
  wxPath: process.env.SOCIOMEM_WECHAT_BIN ?? join(projectRoot, '.tools/agent-wechat/v1.3.2/wx.exe'),
  dataDir: process.env.SOCIOMEM_WECHAT_DATA ?? join(projectRoot, '.runtime/agent-wechat'),
  localProfile: process.env.SOCIOMEM_WECHAT_PROFILE || null,
  profileRoot: process.env.SOCIOMEM_WECHAT_PROFILE_ROOT || null,
});
console.log(JSON.stringify(result, null, 2));
