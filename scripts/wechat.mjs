import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const productName = 'Yuxu 微信引擎';

// These storage paths are compatibility identifiers. Renaming them would select
// a different account store; product naming must not migrate a logged-in account.
export function engineInvocation(args, { root = projectRoot, env = process.env } = {}) {
  const executable = resolve(root, env.SOCIOMEM_WECHAT_CLI ?? '.tools/agent-wechat/v1.3.2/wx.exe');
  const dataDir = resolve(root, env.SOCIOMEM_WECHAT_DATA_DIR ?? '.runtime/agent-wechat');
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const hasDataDir = options.some(value => value === '--data-dir' || value.startsWith('--data-dir='));
  return { executable, args: hasDataDir ? [...args] : ['--data-dir', dataDir, ...args] };
}

export function runWeChatCli(args, { root = projectRoot, env = process.env, execute = spawnSync,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!args.length || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]))) {
    stdout.write(`${productName}\n\n用法：npm.cmd run wechat -- <命令>\n\n` +
      '  --version                 查看 Yuxu 版本\n' +
      '  --licenses                查看第三方组件及许可证说明\n' +
      '  --json accounts list      读取微信账号状态\n' +
      '  serve                     在当前终端运行微信服务\n' +
      '  auth login                发起手机扫码或确认登录\n' +
      '  <命令> --help             查看该命令的参数\n\n' +
      '完整恢复 Agent：双击 Yuxu-Start.exe。\n' +
      '只恢复微信登录：双击 Yuxu-WeChat.exe。\n' +
      '默认复用本项目已有账号目录；本帮助不会启动服务或登录。\n');
    return 0;
  }
  if (args.length === 1 && args[0] === '--version') {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    stdout.write(`${productName} ${version}\n`);
    return 0;
  }
  if (args.length === 1 && args[0] === '--licenses') {
    stdout.write(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
    return 0;
  }
  const invocation = engineInvocation(args, { root, env });
  // Preserve argv, native JSON output and exit status. Never build a shell
  // command or replace identifiers inside protocol responses.
  const result = execute(invocation.executable, invocation.args, {
    cwd: root, env, stdio: 'inherit', shell: false, windowsHide: true,
  });
  if (result.error) {
    stderr.write(`${productName}启动失败：${result.error.code ?? result.error.message}\n`);
    return 1;
  }
  return result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runWeChatCli(process.argv.slice(2));
}
