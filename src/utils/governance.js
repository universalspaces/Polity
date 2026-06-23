/** Pure governance rules shared by commands, handlers, and the scheduler. */

export function votingWindowError(record, now = Math.floor(Date.now() / 1000)) {
  if (!record) return 'not_found';
  if (record.status !== 'active' && record.status !== 'proposed') return 'not_open';
  const deadline = record.ends_at ?? record.voting_deadline;
  if (deadline != null && now >= deadline) return 'expired';
  return null;
}

export function electionDuration(election) {
  const anchor = election.starts_at ?? election.created_at;
  return Math.max(3600, election.ends_at - anchor);
}

export function choiceTally(rows, choices, field = 'vote') {
  const tally = Object.fromEntries(choices.map(choice => [choice, 0]));
  for (const row of rows) {
    if (Object.hasOwn(tally, row[field])) tally[row[field]] += 1;
  }
  return tally;
}

export function fptpTally(candidates, ballots) {
  const counts = new Map(candidates.map(candidate => [candidate.id, 0]));
  for (const ballot of ballots) {
    if (counts.has(ballot.candidate_id)) {
      counts.set(ballot.candidate_id, counts.get(ballot.candidate_id) + 1);
    }
  }

  const ranked = candidates
    .map(candidate => ({ ...candidate, votes: counts.get(candidate.id) ?? 0 }))
    .sort((a, b) => b.votes - a.votes || a.registered_at - b.registered_at || a.id - b.id);
  const topVotes = ranked[0]?.votes ?? null;
  const tiedWinners = topVotes == null ? [] : ranked.filter(candidate => candidate.votes === topVotes);

  return {
    candidates: ranked,
    winner: tiedWinners.length === 1 ? tiedWinners[0] : null,
    tiedWinners,
    topVotes,
  };
}

export function referendumResult(tally) {
  const total = tally.yes + tally.no + tally.abstain;
  if (total === 0) return 'no_votes';
  if (tally.yes === tally.no) return 'tied';
  return tally.yes > tally.no ? 'passed' : 'failed';
}

export function instantRunoff(candidates, ballots) {
  if (!ballots.length || !candidates.length) return { winner: null, rounds: [], eliminated: [], tied: false };
  const active = new Set(candidates.map(candidate => String(candidate.id)));
  const rounds = [];
  const eliminated = [];

  while (active.size) {
    const counts = new Map([...active].map(id => [id, 0]));
    for (const ballot of ballots) {
      const pick = ballot.find(id => active.has(String(id)));
      if (pick != null) counts.set(String(pick), counts.get(String(pick)) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    for (const [id, count] of counts) {
      if (count > total / 2) {
        rounds.push({ counts, eliminated: null });
        return { winner: candidates.find(candidate => String(candidate.id) === id)?.user_id ?? null, rounds, eliminated, tied: false };
      }
    }

    const minimum = Math.min(...counts.values());
    const losers = [...counts].filter(([, count]) => count === minimum).map(([id]) => id);
    if (losers.length === active.size) {
      rounds.push({ counts, eliminated: [], tied: true });
      return { winner: null, rounds, eliminated, tied: true };
    }
    rounds.push({ counts, eliminated: losers });
    for (const id of losers) { active.delete(id); eliminated.push(id); }
    if (active.size === 1) {
      const id = [...active][0];
      return { winner: candidates.find(candidate => String(candidate.id) === id)?.user_id ?? null, rounds, eliminated, tied: false };
    }
  }
  return { winner: null, rounds, eliminated, tied: false };
}
