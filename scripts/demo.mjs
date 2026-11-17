import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRun, createRuntime } from './runtime.mjs';

const run = await prepareRun('demo');
const runtime = createRuntime(run);
let sessionId;
try {
  const result = await runtime.run('[test] inspect context; marker=phase1-persisted');
  sessionId = result.sessionId;
  await writeFile(join(run.runRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log('Offline Harness demo:', result.finalResponse);
  console.log('Session:', result.sessionId);
} finally {
  await runtime.close();
}
const resumed = createRuntime(run);
try {
  const session = await resumed.resumeSession(sessionId);
  const result = await session.run('[test] recall-marker');
  console.log('New process restoration:', result.finalResponse);
} finally {
  await resumed.close();
}
console.log('Artifacts:', run.runRoot);
