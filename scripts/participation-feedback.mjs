import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './runtime.mjs';
import { exportLabeledParticipation, labelParticipationMessage,
  listParticipationReview } from '../packages/participation/feedback.mjs';

const root = join(projectRoot, '.runtime');
const dbPath = process.env.SOCIOMEM_PARTICIPATION_DB ?? join(root, 'participation', 'participation.sqlite');
const inboxPath = process.env.SOCIOMEM_WECHAT_DB ?? join(root, 'wechat-adapter', 'sociomem.sqlite');
const [command, ...args] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: command !== 'label' });
db.exec('PRAGMA busy_timeout=5000');
try {
  if (command === 'list') {
    if (args.length > 1) throw new Error('Usage: participation:feedback list [limit]');
    console.log(JSON.stringify(listParticipationReview(db, inboxPath,
      { limit: args.length ? Number(args[0]) : 20 }), null, 2));
  } else if (command === 'label') {
    const [sourceMessageId, label, ...options] = args;
    if (!sourceMessageId || !label) throw new Error('Usage: participation:feedback label <message-id> reply|skip|unsure [--reply TEXT] [--note TEXT]');
    let preferredReply = null, note = null;
    for (let i = 0; i < options.length; i += 2) {
      if (options[i] === '--reply' && preferredReply === null) preferredReply = options[i + 1];
      else if (options[i] === '--note' && note === null) note = options[i + 1];
      else throw new Error('Invalid feedback option');
    }
    console.log(JSON.stringify(labelParticipationMessage(db, inboxPath,
      { sourceMessageId, label, preferredReply, note }), null, 2));
  } else if (command === 'export') {
    if (args.length > 1 || (args[0] && !/^[a-zA-Z0-9_-]+\.jsonl$/u.test(args[0]))) {
      throw new Error('Usage: participation:feedback export [name.jsonl]');
    }
    const directory = join(root, 'feedback');
    const filename = join(directory, args[0] ?? 'participation-labeled.jsonl');
    const rows = exportLabeledParticipation(db, inboxPath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    writeFileSync(temporary, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
      { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, filename);
    console.log(JSON.stringify({ filename, labeledMessages: rows.length }));
  } else throw new Error('Usage: participation:feedback list [limit] | label <message-id> reply|skip|unsure [--reply TEXT] [--note TEXT] | export [name.jsonl]');
} catch (error) {
  console.error(`participation-feedback: ${error.message}`);
  process.exitCode = 1;
} finally { db.close(); }
