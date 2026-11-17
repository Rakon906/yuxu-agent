// Acknowledge local Inbox delivery without creating a model run or reply draft.
export async function capturePending(adapter, allowedGroups, onCaptured = () => {}) {
  const allowed = new Set(allowedGroups);
  await adapter.drain(async message => {
    if (!allowed.has(message.groupId)) throw new Error('Pending message belongs to a group outside the allowlist');
    await onCaptured(message);
  });
}
