/**
 * utils/voting.js — Reusable vote-recording logic.
 *
 * Centralises bill vote recording (used by both /bill vote and button handlers)
 * and ranked-choice vote tallying.  Each public function is a pure business-logic
 * unit with no Discord interaction side effects.
 */

import db, { q, tx } from '../database.js';
import { choiceTally, instantRunoff, votingWindowError } from './governance.js';

// ── Bill votes ────────────────────────────────────────────────────────────────

/**
 * Record or change a bill vote atomically.
 *
 * Returns one of:
 *   { ok: true,  changed: false }  — new vote
 *   { ok: true,  changed: true, previous }  — vote changed
 *   { ok: false, reason }  — validation failure (not an error, reply to user)
 */
export function castBillVote(guildId, billId, voterId, vote) {
  if (!['yes', 'no', 'abstain'].includes(vote)) return { ok: false, reason: 'Invalid vote.' };
  const bill = q.getBill.get(billId, guildId);
  if (!bill)                      return { ok: false, reason: `Bill #${billId} not found.` };
  const windowError = votingWindowError(bill);
  if (windowError === 'not_open') return { ok: false, reason: 'This bill is no longer open for voting.' };
  if (windowError === 'expired')  return { ok: false, reason: 'The voting deadline for this bill has passed.' };

  const existing = q.getBillVote.get(billId, voterId);

  return tx(() => {
    if (existing) {
      if (existing.vote === vote) {
        return { ok: false, reason: `You already voted **${voteLabel(vote)}** on this bill.` };
      }
      q.changeBillVote.run(vote, billId, voterId);
      reconcileBillTally(billId);
      return { ok: true, changed: true, previous: existing.vote };
    }

    q.castBillVote.run(billId, voterId, vote);
    reconcileBillTally(billId);
    return { ok: true, changed: false };
  })();
}

function reconcileBillTally(billId) {
  const tally = getBillTally(billId);
  db.prepare('UPDATE bills SET votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ?')
    .run(tally.yes, tally.no, tally.abstain, billId);
  return tally;
}

export function getBillTally(billId) {
  return choiceTally(db.prepare('SELECT vote FROM bill_votes WHERE bill_id = ?').all(billId), ['yes', 'no', 'abstain']);
}

export function getReferendumTally(referendumId) {
  return choiceTally(
    db.prepare('SELECT vote FROM referendum_votes WHERE referendum_id = ?').all(referendumId),
    ['yes', 'no', 'abstain'],
  );
}

export function castReferendumVote(guildId, referendumId, voterId, vote) {
  if (!['yes', 'no', 'abstain'].includes(vote)) return { ok: false, reason: 'Invalid vote.' };
  const referendum = db.prepare('SELECT * FROM referendums WHERE id = ? AND guild_id = ?').get(referendumId, guildId);
  if (!referendum) return { ok: false, reason: `Referendum #${referendumId} not found.` };
  const windowError = votingWindowError(referendum);
  if (windowError === 'not_open') return { ok: false, reason: 'This referendum is no longer open for voting.' };
  if (windowError === 'expired') return { ok: false, reason: 'This referendum has already closed.' };

  const existing = db.prepare('SELECT vote FROM referendum_votes WHERE referendum_id = ? AND voter_id = ?').get(referendumId, voterId);
  if (existing?.vote === vote) return { ok: false, reason: `You already voted **${vote.toUpperCase()}** on this referendum.` };

  return tx(() => {
    db.prepare(`
      INSERT INTO referendum_votes (referendum_id, voter_id, vote)
      VALUES (?, ?, ?)
      ON CONFLICT(referendum_id, voter_id) DO UPDATE SET vote = excluded.vote, voted_at = unixepoch()
    `).run(referendumId, voterId, vote);
    const tally = getReferendumTally(referendumId);
    db.prepare('UPDATE referendums SET votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ?')
      .run(tally.yes, tally.no, tally.abstain, referendumId);
    return { ok: true, changed: Boolean(existing), previous: existing?.vote, referendum, tally };
  })();
}

export function getImpeachmentTally(impeachmentId) {
  return choiceTally(
    db.prepare('SELECT vote FROM impeachment_votes WHERE impeachment_id = ?').all(impeachmentId),
    ['convict', 'acquit', 'abstain'],
  );
}

export function castImpeachmentVote(guildId, impeachmentId, voterId, vote) {
  if (!['convict', 'acquit', 'abstain'].includes(vote)) return { ok: false, reason: 'Invalid vote.' };
  const proceeding = db.prepare('SELECT * FROM impeachments WHERE id = ? AND guild_id = ?').get(impeachmentId, guildId);
  if (!proceeding) return { ok: false, reason: `Impeachment #${impeachmentId} not found.` };
  if (proceeding.status !== 'trial') return { ok: false, reason: 'This impeachment trial is no longer active.' };
  if (proceeding.target_id === voterId) return { ok: false, reason: 'You cannot vote in your own impeachment trial.' };
  const existing = db.prepare('SELECT 1 FROM impeachment_votes WHERE impeachment_id = ? AND voter_id = ?').get(impeachmentId, voterId);
  if (existing) return { ok: false, reason: 'You have already voted in this proceeding.' };

  return tx(() => {
    db.prepare('INSERT INTO impeachment_votes (impeachment_id, voter_id, vote) VALUES (?, ?, ?)').run(impeachmentId, voterId, vote);
    const tally = getImpeachmentTally(impeachmentId);
    db.prepare('UPDATE impeachments SET votes_convict = ?, votes_acquit = ?, votes_abstain = ? WHERE id = ?')
      .run(tally.convict, tally.acquit, tally.abstain, impeachmentId);
    return { ok: true, proceeding, tally };
  })();
}

export function voteLabel(vote) {
  return { yes: '✅ Yea', no: '❌ Nay', abstain: '⬛ Abstain' }[vote] ?? vote;
}

export function voteEmoji(vote) {
  return { yes: '✅', no: '❌', abstain: '⬛' }[vote] ?? '❓';
}

// ── Ranked Choice Vote counting ───────────────────────────────────────────────

/**
 * Run an instant-runoff (RCV) tally.
 * @param {number} electionId
 * @returns {{ winner: string|null, rounds: Round[], eliminated: string[] }}
 *   where Round = { counts: Map<candidateId, number>, eliminated: string|null }
 */
export function runRCV(electionId) {
  const rawVotes = db.prepare('SELECT preferences FROM rcv_votes WHERE election_id = ?').all(electionId);
  const candidates = db.prepare('SELECT id, user_id FROM candidates WHERE election_id = ?').all(electionId);
  return instantRunoff(candidates, rawVotes.map(row => JSON.parse(row.preferences)));
}
