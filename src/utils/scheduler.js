/**
 * utils/scheduler.js — Cron-driven election/referendum lifecycle manager.
 *
 * Runs every minute via node-cron. Handles:
 *  - Starting scheduled elections
 *  - Closing active elections (FPTP + RCV)
 *  - Closing expired referendums
 *  - Sending DM reminders for elections closing soon
 *  - Expiring overdue initiatives & recalls
 *  - Auto-rejecting bills past their voting deadline
 */

import { EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { getBillTally, runRCV } from './voting.js';
import { Colors, makeEmbed, ts } from './embeds.js';
import { choiceTally, fptpTally, referendumResult } from './governance.js';

// ── Public entry point ────────────────────────────────────────────────────────

export async function tick(client) {
  const now = Math.floor(Date.now() / 1000);
  await Promise.allSettled([
    startScheduledElections(client, now),
    closeExpiredElections(client, now),
    closeExpiredReferendums(client, now),
    sendDueReminders(client, now),
    expireInitiatives(now),
    expireRecalls(now),
    rejectExpiredBills(client, now),
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startScheduledElections(client, now) {
  const rows = db.prepare(`SELECT * FROM elections WHERE status = 'registration' AND starts_at IS NOT NULL AND starts_at <= ?`).all(now);
  for (const el of rows) {
    const claimed = db.prepare(`UPDATE elections SET status = 'active' WHERE id = ? AND status = 'registration'`).run(el.id);
    if (claimed.changes !== 1) continue;
    await postAnnouncement(client, el.guild_id, makeEmbed(Colors.success)
      .setTitle('🗳️ Voting is Now Open!')
      .setDescription(`**${el.title}** has opened for voting.`)
      .addFields(
        { name: '💼 Office',  value: el.office,               inline: true },
        { name: '⏰ Closes',  value: ts(el.ends_at, 'R'),     inline: true },
        { name: '📊 System',  value: el.voting_type === 'rcv' ? 'Ranked Choice' : 'First Past the Post', inline: true },
      )
      .setFooter({ text: `Election #${el.id} · Use /vote to cast your ballot` })
    );
  }
}

export async function closeElection(client, election) {
  const result = election.voting_type === 'rcv'
    ? await closeRcvElection(client, election)
    : await closeFptpElection(client, election);
  return result;
}

async function closeExpiredElections(client, now) {
  const rows = db.prepare(`SELECT * FROM elections WHERE status = 'active' AND ends_at <= ?`).all(now);
  for (const el of rows) await closeElection(client, el).catch(console.error);
}

async function closeFptpElection(client, election) {
  const tally = db.transaction(() => {
    const candidates = db.prepare('SELECT * FROM candidates WHERE election_id = ?').all(election.id);
    const ballots = db.prepare('SELECT candidate_id FROM votes WHERE election_id = ?').all(election.id);
    const result = fptpTally(candidates, ballots);
    const claimed = db.prepare(`UPDATE elections SET status = 'closed', winner_id = ? WHERE id = ? AND status = 'active'`)
      .run(result.winner?.user_id ?? null, election.id);
    if (claimed.changes !== 1) return null;
    const reconcile = db.prepare('UPDATE candidates SET votes = ? WHERE id = ?');
    for (const candidate of result.candidates) reconcile.run(candidate.votes, candidate.id);
    db.prepare(`UPDATE recalls SET status = 'completed' WHERE election_id = ? AND status = 'election_called'`).run(election.id);
    return { ...result, officeChange: result.winner ? updateOfficeHolder(election, result.winner.user_id) : null };
  })();
  if (!tally) return { closed: false };

  const { candidates, topVotes, tiedWinners, winner } = tally;

  if (tally.officeChange) await syncOfficeRoles(client, election, tally.officeChange);

  const resultLines = candidates.length
    ? candidates.map((c, i) => `**${i + 1}.** <@${c.user_id}> — ${c.votes} vote${c.votes !== 1 ? 's' : ''}`).join('\n')
    : '*No candidates.*';

  const description = winner
    ? `**Winner: <@${winner.user_id}>**`
    : tiedWinners.length > 1
      ? `⚠️ **Tie:** ${tiedWinners.map(c => `<@${c.user_id}>`).join(', ')} each received ${topVotes} vote${topVotes !== 1 ? 's' : ''}. No winner was assigned.`
      : '*No winner — no candidates ran.*';

  await postAnnouncement(client, election.guild_id, makeEmbed(winner ? Colors.warning : Colors.danger)
    .setTitle(`🏆 Election Closed: ${election.title}`)
    .setDescription(description)
    .addFields(
      { name: '💼 Office',   value: election.office,      inline: true },
      { name: '📊 System',   value: 'First Past the Post', inline: true },
      { name: '📋 Results',  value: resultLines },
    )
    .setFooter({ text: `Election #${election.id}` })
  );
  return { closed: true, winner: winner?.user_id ?? null };
}

function updateOfficeHolder(election, winnerUserId) {
  const office = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND name = ?')
    .get(election.guild_id, election.office);
  if (!office) return null;

  const prev = office.holder_id;
  const now  = Math.floor(Date.now() / 1000);
  if (prev) {
    db.prepare('INSERT INTO office_history (guild_id, office_name, user_id, assumed_at, vacated_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(election.guild_id, election.office, prev, office.assumed_at ?? now, now, 'election');
  }
  db.prepare('UPDATE offices SET holder_id = ?, assumed_at = ? WHERE id = ?').run(winnerUserId, now, office.id);
  return { office, prev, winnerUserId };
}

async function syncOfficeRoles(client, election, { office, prev, winnerUserId }) {
  if (!office.role_id) return;

  const guild = await client.guilds.fetch(election.guild_id).catch(err => {
    console.warn(`[ROLE SYNC ${election.id}] Unable to fetch guild ${election.guild_id}:`, err);
    return null;
  });
  if (!guild) return;

  if (prev && prev !== winnerUserId) {
    const previousMember = await guild.members.fetch(prev).catch(err => {
      console.warn(`[ROLE SYNC ${election.id}] Unable to fetch previous holder ${prev}:`, err);
      return null;
    });
    if (previousMember) await previousMember.roles.remove(office.role_id).catch(err => {
      console.warn(`[ROLE SYNC ${election.id}] Unable to remove role ${office.role_id} from ${prev}:`, err);
    });
  }

  const winnerMember = await guild.members.fetch(winnerUserId).catch(err => {
    console.warn(`[ROLE SYNC ${election.id}] Unable to fetch winner ${winnerUserId}:`, err);
    return null;
  });
  if (winnerMember) await winnerMember.roles.add(office.role_id).catch(err => {
    console.warn(`[ROLE SYNC ${election.id}] Unable to add role ${office.role_id} to ${winnerUserId}:`, err);
  });
}

async function closeRcvElection(client, election) {
  const { winner, rounds, tied } = runRCV(election.id);
  const officeChange = db.transaction(() => {
    const claimed = db.prepare(`UPDATE elections SET status = 'closed', winner_id = ? WHERE id = ? AND status = 'active'`)
      .run(winner ?? null, election.id);
    if (claimed.changes !== 1) return false;
    db.prepare(`UPDATE recalls SET status = 'completed' WHERE election_id = ? AND status = 'election_called'`).run(election.id);
    return winner ? updateOfficeHolder(election, winner) : null;
  })();
  if (officeChange === false) return { closed: false };
  if (officeChange) await syncOfficeRoles(client, election, officeChange);

  const roundSummary = rounds.slice(-1)[0];
  const roundText = roundSummary
    ? [...roundSummary.counts.entries()]
        .map(([id, v]) => {
          const cand = db.prepare('SELECT user_id FROM candidates WHERE id = ?').get(id);
          return cand ? `<@${cand.user_id}>: ${v}` : null;
        })
        .filter(Boolean)
        .join('\n')
    : '*No votes cast.*';

  const description = winner
    ? `**Winner: <@${winner}>** after ${rounds.length} round(s)`
    : tied
      ? '⚠️ **Tie:** no automatic winner was assigned.'
      : '*No winner determined.*';

  await postAnnouncement(client, election.guild_id, makeEmbed(winner ? Colors.warning : Colors.danger)
    .setTitle(`🏆 Election Closed (RCV): ${election.title}`)
    .setDescription(description)
    .addFields(
      { name: '💼 Office',       value: election.office,     inline: true },
      { name: '📊 System',       value: 'Ranked Choice',     inline: true },
      { name: '🔢 Rounds',       value: `${rounds.length}`,  inline: true },
      { name: '📋 Final Round',  value: roundText || '*No active ballots.*' },
    )
    .setFooter({ text: `Election #${election.id}` })
  );
  return { closed: true, winner: winner ?? null };
}

async function closeExpiredReferendums(client, now) {
  const rows = db.prepare(`SELECT * FROM referendums WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?`).all(now);
  for (const ref of rows) {
    const ballots = db.prepare('SELECT vote FROM referendum_votes WHERE referendum_id = ?').all(ref.id);
    const tally = choiceTally(ballots, ['yes', 'no', 'abstain']);
    const total = tally.yes + tally.no + tally.abstain;
    const result = referendumResult(tally);
    const claimed = db.prepare(`UPDATE referendums SET status = 'closed', result = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'active'`)
      .run(result, tally.yes, tally.no, tally.abstain, ref.id);
    if (claimed.changes !== 1) continue;
    const yPct = total > 0 ? ((tally.yes / total) * 100).toFixed(1) : '0.0';
    const nPct = total > 0 ? ((tally.no  / total) * 100).toFixed(1) : '0.0';

    const resultLabel = { passed: '✅ PASSED', failed: '❌ FAILED', tied: '🟡 TIED', no_votes: '⬛ NO VOTES' };
    await postAnnouncement(client, ref.guild_id, makeEmbed(result === 'passed' ? Colors.success : result === 'tied' ? Colors.warning : Colors.danger)
      .setTitle(`📊 Referendum Closed: ${ref.title}`)
      .setDescription(`Result: **${resultLabel[result]}**`)
      .addFields(
        { name: '✅ Yes',     value: `${tally.yes} (${yPct}%)`,  inline: true },
        { name: '❌ No',      value: `${tally.no} (${nPct}%)`,   inline: true },
        { name: '⬛ Abstain', value: `${tally.abstain}`,          inline: true },
      )
      .setFooter({ text: `Referendum #${ref.id}` })
    );
  }
}

async function sendDueReminders(client, now) {
  const reminders = db.prepare('SELECT * FROM election_reminders WHERE sent = 0 AND remind_at <= ?').all(now);
  for (const r of reminders) {
    try {
      const election = db.prepare('SELECT * FROM elections WHERE id = ?').get(r.election_id);
      if (!election || election.status === 'closed') continue;
      const user = await client.users.fetch(r.user_id).catch(() => null);
      if (user) {
        await user.send({ embeds: [
          makeEmbed(Colors.warning)
            .setTitle('⏰ Election Closing Soon!')
            .setDescription(`**${election.title}** is closing soon — don't forget to vote!`)
            .addFields(
              { name: '💼 Office',  value: election.office,         inline: true },
              { name: '⏰ Closes',  value: ts(election.ends_at, 'R'), inline: true },
            )
            .setFooter({ text: 'Use /vote in the server to cast your ballot.' }),
        ]}).catch(() => {});
      }
    } catch (err) {
      console.warn(`[REMINDER ${r.election_id}/${r.user_id}]`, err);
    }
    db.prepare('UPDATE election_reminders SET sent = 1 WHERE guild_id = ? AND user_id = ? AND election_id = ?')
      .run(r.guild_id, r.user_id, r.election_id);
  }
}

function expireInitiatives(now) {
  db.prepare(`UPDATE initiatives SET status = 'expired' WHERE status = 'collecting' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now);
}

function expireRecalls(now) {
  db.prepare(`UPDATE recalls SET status = 'expired' WHERE status = 'collecting' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now);
}

async function rejectExpiredBills(client, now) {
  const expired = db.prepare(`
    SELECT * FROM bills
    WHERE status = 'proposed' AND voting_deadline IS NOT NULL AND voting_deadline <= ?
  `).all(now);

  for (const bill of expired) {
    const tally = getBillTally(bill.id);
    const claimed = db.prepare(`UPDATE bills SET status = 'rejected', voted_at = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'proposed'`)
      .run(now, tally.yes, tally.no, tally.abstain, bill.id);
    if (claimed.changes !== 1) continue;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(bill.guild_id);
    if (!config?.legislature_channel) continue;
    try {
      const guild   = await client.guilds.fetch(bill.guild_id);
      const channel = await guild.channels.fetch(config.legislature_channel);
      await channel.send({ embeds: [
        makeEmbed(Colors.danger)
          .setTitle(`⏰ Bill Expired: ${bill.title}`)
          .setDescription(`Bill **#${bill.id}** was automatically rejected — the voting deadline passed with no admin action.`)
          .addFields(
            { name: '✅ Yea',     value: `${tally.yes}`,     inline: true },
            { name: '❌ Nay',     value: `${tally.no}`,      inline: true },
            { name: '⬛ Abstain', value: `${tally.abstain}`, inline: true },
          )
          .setFooter({ text: `Bill #${bill.id}` }),
      ]});
    } catch (err) {
      console.warn(`[BILL EXPIRE ${bill.id}]`, err);
    }
  }
}

// ── Channel helper ────────────────────────────────────────────────────────────

async function postAnnouncement(client, guildId, embed) {
  const config = db.prepare('SELECT election_channel, announcement_channel FROM server_config WHERE guild_id = ?').get(guildId);
  const channelId = config?.election_channel ?? config?.announcement_channel;
  if (!channelId) return;
  try {
    const guild   = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn(`[ANNOUNCEMENT ${guildId}]`, err);
  }
}
