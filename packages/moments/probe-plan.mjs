/**
 * Candidate request bodies for the Moments timeline.
 *
 * The field numbers below are *probes*, not confirmed schema. Every request
 * can prepend the account's BaseRequest as field 1, which the micromsg cgis
 * require; the field list after it follows the classic `SnsTimeLineRequest`
 * layout. Each candidate is sent once, in order, and the reply is recorded; a
 * candidate that returns base code 0 with a non-empty object list is the one to
 * keep.
 */
import { bytesToHex, encodeFields, outline, tryDecode } from './protobuf.mjs';

export const TIMELINE_CGI = 211;

export function timelineBodies(currentTime = Math.floor(Date.now() / 1000)) {
  return [
    { name: 'base-only', withBaseRequest: true, fields: [] },
    { name: 'base+firstPageMd5-empty', withBaseRequest: true, fields: [{ number: 2, bytes: '' }] },
    { name: 'base+maxId0+minId0', withBaseRequest: true,
      fields: [{ number: 3, varint: 0 }, { number: 4, varint: 0 }] },
    { name: 'base+currentTime', withBaseRequest: true, fields: [{ number: 6, varint: currentTime }] },
    { name: 'base+source1', withBaseRequest: true, fields: [{ number: 7, varint: 1 }] },
    { name: 'base+timeline-classic', withBaseRequest: true, fields: [
      { number: 2, bytes: '' }, { number: 3, varint: 0 }, { number: 4, varint: 0 },
      { number: 5, varint: 0 }, { number: 6, varint: currentTime }, { number: 7, varint: 1 },
    ] },
    { name: 'base+clientLatestId-empty', withBaseRequest: true, fields: [{ number: 8, bytes: '' }] },
    { name: 'base+network1+scene0', withBaseRequest: true,
      fields: [{ number: 9, varint: 1 }, { number: 10, varint: 0 }] },
    { name: 'legacy-empty-no-base', withBaseRequest: false, fields: [] },
  ];
}

export const TIMELINE_BODIES = timelineBodies();

export async function runProbePlan({ client, cgi = TIMELINE_CGI, bodies = timelineBodies() }) {
  const results = [];
  for (const body of bodies) {
    const bodyHex = bytesToHex(encodeFields(body.fields));
    const record = { name: body.name, cgi, bodyHex, withBaseRequest: body.withBaseRequest === true };
    try {
      const reply = await client.probe(cgi, bodyHex, { withBaseRequest: body.withBaseRequest === true });
      if (reply.ok === false) {
        results.push({ ...record, ok: false, error: reply.detail ?? 'operation_failed', replyHex: '' });
        continue;
      }
      const raw = Buffer.from(String(reply.replyHex ?? ''), 'hex');
      const decoded = tryDecode(raw);
      results.push({
        ...record,
        ok: true,
        baseCode: reply.baseCode ?? null,
        baseMessage: reply.baseMessage ?? null,
        replyBytes: reply.replyBytes ?? raw.length,
        fieldCount: decoded.ok ? decoded.fields.length : null,
        outline: decoded.ok ? outline(decoded.fields) : [`decode failed: ${decoded.error}`],
        replyHex: reply.replyHex ?? '',
      });
    } catch (error) {
      results.push({ ...record, ok: false, error: error.message, replyHex: '' });
    }
  }
  return results;
}

/** Same results without the raw payload; safe to print or log. */
export function summarize(results) {
  return results.map(({ replyHex, ...rest }) => ({
    ...rest,
    replyHexBytes: replyHex ? replyHex.length / 2 : 0,
  }));
}
