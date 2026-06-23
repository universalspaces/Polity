import test from 'node:test';
import assert from 'node:assert/strict';
import {
  choiceTally,
  electionDuration,
  fptpTally,
  instantRunoff,
  referendumResult,
  votingWindowError,
} from '../src/utils/governance.js';

test('voting windows reject closed and exactly-expired records', () => {
  assert.equal(votingWindowError({ status: 'active', ends_at: 101 }, 100), null);
  assert.equal(votingWindowError({ status: 'active', ends_at: 100 }, 100), 'expired');
  assert.equal(votingWindowError({ status: 'closed', ends_at: 200 }, 100), 'not_open');
  assert.equal(votingWindowError({ status: 'proposed', voting_deadline: 100 }, 100), 'expired');
});

test('manual openings preserve the configured duration', () => {
  assert.equal(electionDuration({ created_at: 100, starts_at: null, ends_at: 7300 }), 7200);
  assert.equal(electionDuration({ created_at: 100, starts_at: 1000, ends_at: 4600 }), 3600);
});

test('choice tallies derive from authoritative rows and ignore invalid values', () => {
  assert.deepEqual(choiceTally([{ vote: 'yes' }, { vote: 'no' }, { vote: 'yes' }, { vote: 'bogus' }], ['yes', 'no', 'abstain']), {
    yes: 2, no: 1, abstain: 0,
  });
});

test('FPTP ignores stale cached counters and detects a unique winner', () => {
  const candidates = [
    { id: 1, user_id: 'a', votes: 99, registered_at: 1 },
    { id: 2, user_id: 'b', votes: 0, registered_at: 2 },
  ];
  const result = fptpTally(candidates, [{ candidate_id: 2 }, { candidate_id: 2 }, { candidate_id: 999 }]);
  assert.equal(result.winner.user_id, 'b');
  assert.deepEqual(result.candidates.map(candidate => candidate.votes), [2, 0]);
});

test('FPTP leaves exact ties unresolved', () => {
  const candidates = [{ id: 1, user_id: 'a', registered_at: 1 }, { id: 2, user_id: 'b', registered_at: 2 }];
  const result = fptpTally(candidates, [{ candidate_id: 1 }, { candidate_id: 2 }]);
  assert.equal(result.winner, null);
  assert.equal(result.tiedWinners.length, 2);
});

test('instant runoff transfers ballots and reports full-field ties', () => {
  const candidates = [{ id: 1, user_id: 'a' }, { id: 2, user_id: 'b' }, { id: 3, user_id: 'c' }];
  assert.equal(instantRunoff(candidates, [[1, 2], [2, 1], [2, 1], [3, 1], [3, 2]]).winner, 'b');
  assert.equal(instantRunoff(candidates, [[1], [2], [3]]).tied, true);
});

test('referendum outcomes distinguish no-vote, tie, pass, and fail', () => {
  assert.equal(referendumResult({ yes: 0, no: 0, abstain: 0 }), 'no_votes');
  assert.equal(referendumResult({ yes: 1, no: 1, abstain: 5 }), 'tied');
  assert.equal(referendumResult({ yes: 2, no: 1, abstain: 0 }), 'passed');
  assert.equal(referendumResult({ yes: 1, no: 2, abstain: 0 }), 'failed');
});
