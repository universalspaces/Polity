import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { replyError, logActivity, ts } from '../utils/embeds.js';
import { votingWindowError } from '../utils/governance.js';

export default {
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Cast your vote in an active election')
    .addIntegerOption(o => o.setName('election_id').setDescription('The election ID').setRequired(true))
    .addUserOption(o => o.setName('candidate').setDescription('Candidate to vote for (FPTP) or 1st choice (RCV)').setRequired(true))
    .addUserOption(o => o.setName('rank2').setDescription('2nd choice (RCV only)'))
    .addUserOption(o => o.setName('rank3').setDescription('3rd choice (RCV only)'))
    .addUserOption(o => o.setName('rank4').setDescription('4th choice (RCV only)'))
    .addUserOption(o => o.setName('rank5').setDescription('5th choice (RCV only)')),

  async execute(interaction) {
    const gid        = interaction.guildId;
    const uid        = interaction.user.id;
    const electionId = interaction.options.getInteger('election_id');

    const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(electionId, gid);
    if (!election)                     return replyError(interaction, `Election #${electionId} not found.`);
    const windowError = votingWindowError(election);
    if (windowError === 'not_open') return replyError(interaction, 'This election is not currently open for voting.');
    if (windowError === 'expired') {
      return replyError(interaction, 'This election has already closed. Results are being tallied.');
    }

    const candidate1 = interaction.options.getUser('candidate');

    if (election.voting_type !== 'rcv') {
      return castFptp(interaction, gid, uid, election, candidate1);
    }
    return castRcv(interaction, gid, uid, election, candidate1);
  },
};

async function castFptp(interaction, gid, uid, election, candidateUser) {
  const existing = db.prepare('SELECT 1 FROM votes WHERE election_id = ? AND voter_id = ?').get(election.id, uid);
  if (existing) return replyError(interaction, 'You have already voted in this election.');

  const candidate = db.prepare('SELECT * FROM candidates WHERE election_id = ? AND user_id = ?').get(election.id, candidateUser.id);
  if (!candidate) return replyError(interaction, `${candidateUser.username} is not a candidate in this election.`);

  db.transaction(() => {
    db.prepare('INSERT INTO votes (election_id, voter_id, candidate_id) VALUES (?, ?, ?)').run(election.id, uid, candidate.id);
    // Keep the display cache synchronized from authoritative ballot rows.
    db.prepare('UPDATE candidates SET votes = (SELECT COUNT(*) FROM votes WHERE candidate_id = ?) WHERE id = ?')
      .run(candidate.id, candidate.id);
    logActivity(gid, 'VOTE_CAST', uid, `Election #${election.id}`, `Voted for ${candidateUser.id}`);
  })();

  const party = candidate.party_id
    ? db.prepare('SELECT * FROM parties WHERE id = ?').get(candidate.party_id)
    : null;

  return interaction.reply({ embeds: [
    new EmbedBuilder()
      .setColor(0x57F287).setTimestamp()
      .setTitle('🗳️ Vote Cast!')
      .setDescription(`You voted for **${candidateUser.username}** in **${election.title}**.`)
      .addFields({ name: '🏛️ Party', value: party ? `${party.emoji} ${party.name}` : 'Independent', inline: true })
      .setFooter({ text: 'Your vote has been recorded.' }),
  ], flags: 64 });
}

async function castRcv(interaction, gid, uid, election, candidate1) {
  const existing = db.prepare('SELECT 1 FROM rcv_votes WHERE election_id = ? AND voter_id = ?').get(election.id, uid);
  if (existing) return replyError(interaction, 'You have already voted in this election.');

  const allCandidates = db.prepare('SELECT * FROM candidates WHERE election_id = ?').all(election.id);
  const byUserId      = new Map(allCandidates.map(c => [c.user_id, c]));

  const rankInputs = [
    candidate1,
    interaction.options.getUser('rank2'),
    interaction.options.getUser('rank3'),
    interaction.options.getUser('rank4'),
    interaction.options.getUser('rank5'),
  ].filter(Boolean);

  const seen        = new Set();
  const preferences = [];
  for (const user of rankInputs) {
    if (!byUserId.has(user.id))  return replyError(interaction, `${user.username} is not a candidate in this election.`);
    if (seen.has(user.id))       return replyError(interaction, `You ranked ${user.username} more than once.`);
    seen.add(user.id);
    preferences.push(byUserId.get(user.id).id);
  }

  db.prepare('INSERT INTO rcv_votes (election_id, voter_id, preferences) VALUES (?, ?, ?)').run(election.id, uid, JSON.stringify(preferences));
  logActivity(gid, 'RCV_VOTE_CAST', uid, `Election #${election.id}`, `${preferences.length} preferences`);

  return interaction.reply({ embeds: [
    new EmbedBuilder()
      .setColor(0x57F287).setTimestamp()
      .setTitle('📊 Ranked Choice Vote Cast!')
      .setDescription(`Your ballot for **${election.title}** has been recorded.`)
      .addFields({ name: '🏆 Your Rankings', value: rankInputs.map((u, i) => `**${i + 1}.** ${u.username}`).join('\n') })
      .setFooter({ text: 'Results use instant-runoff to find the majority winner.' }),
  ], flags: 64 });
}
