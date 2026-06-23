import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { successEmbed, errorEmbed, infoEmbed, listEmbeds, replyError, logActivity, statusField, ts, now } from '../utils/embeds.js';
import { closeElection } from '../utils/scheduler.js';
import { electionDuration } from '../utils/governance.js';

export default {
  data: new SlashCommandBuilder()
    .setName('election')
    .setDescription('Manage elections')
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a new election')
      .addStringOption(o => o.setName('title').setDescription('Election title').setRequired(true))
      .addStringOption(o => o.setName('office').setDescription('Office being contested').setRequired(true))
      .addIntegerOption(o => o.setName('hours').setDescription('Voting duration in hours (default: server default)').setMinValue(1).setMaxValue(720))
      .addStringOption(o => o.setName('description').setDescription('Election description'))
      .addStringOption(o => o.setName('type').setDescription('Voting system')
        .addChoices(
          { name: 'First Past the Post (default)', value: 'fptp' },
          { name: 'Ranked Choice Voting (RCV)',    value: 'rcv'  },
        ))
      .addIntegerOption(o => o.setName('start_in_hours').setDescription('Hours from now to open voting (omit = immediate registration)').setMinValue(1).setMaxValue(720)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('View all elections'))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View election details')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('open')
      .setDescription('Open an election for voting immediately (admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('close')
      .setDescription('Force-close and tally an election (admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('cancel')
      .setDescription('Cancel an election (admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('register')
      .setDescription('Register as a candidate in an election')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true))
      .addStringOption(o => o.setName('platform').setDescription('Your campaign platform')))
    .addSubcommand(s => s
      .setName('withdraw')
      .setDescription('Withdraw your candidacy')
      .addIntegerOption(o => o.setName('id').setDescription('Election ID').setRequired(true))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    switch (sub) {
      case 'create':   return create(interaction, gid, uid, client);
      case 'list':     return list(interaction, gid);
      case 'info':     return info(interaction, gid);
      case 'open':     return open(interaction, gid, uid, client);
      case 'close':    return forceClose(interaction, gid, uid, client);
      case 'cancel':   return cancel(interaction, gid, uid);
      case 'register': return register(interaction, gid, uid);
      case 'withdraw': return withdraw(interaction, gid, uid);
    }
  },
};

// ── Sub-handlers ──────────────────────────────────────────────────────────────

async function create(interaction, gid, uid, client) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, 'You need **Manage Server** permission.');
  }
  const config      = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
  const title       = interaction.options.getString('title');
  const office      = interaction.options.getString('office');
  const description = interaction.options.getString('description') ?? '';
  const type        = interaction.options.getString('type') ?? 'fptp';
  const hours       = interaction.options.getInteger('hours') ?? config?.election_duration_hours ?? 48;
  const startIn     = interaction.options.getInteger('start_in_hours');

  const n         = now();
  // A missing schedule means "registration is open until an admin opens the
  // election", not "open voting on the next scheduler tick".  For unscheduled
  // elections, ends_at temporarily anchors the requested duration to created_at;
  // open() shifts that window to the actual opening time below.
  const startsAt  = startIn ? n + startIn * 3600 : null;
  const endsAt    = (startsAt ?? n) + hours * 3600;
  const status    = 'registration';

  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO elections (guild_id, title, office, description, status, voting_type, starts_at, ends_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gid, title, office, description, status, type, startsAt, endsAt, uid);

  logActivity(gid, 'ELECTION_CREATED', uid, title, `Office: ${office}, Type: ${type.toUpperCase()}`);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2).setTimestamp()
    .setTitle('🗳️ New Election Created!')
    .setDescription(`**${title}**\n${description}`)
    .addFields(
      { name: '🏛️ Office',    value: office,                                                              inline: true },
      { name: '🆔 ID',         value: `#${id}`,                                                            inline: true },
      { name: '📊 System',     value: type === 'rcv' ? '📊 Ranked Choice' : '🥇 First Past the Post',     inline: true },
      statusField('registration', startIn ? `Voting starts ${ts(startsAt, 'R')}` : 'Awaiting an administrator to open voting'),
      { name: '⏰ Voting Window', value: startIn ? `Ends ${ts(endsAt)}` : `${hours} hour(s) after an admin opens voting`, inline: false },
    )
    .setFooter({ text: `Use /election register id:${id} to run for office!` });

  const ch = config?.election_channel
    ? await interaction.guild.channels.fetch(config.election_channel).catch(() => null)
    : null;

  if (ch && ch.id !== interaction.channelId) {
    await ch.send({ embeds: [embed] });
    return interaction.reply({ content: `✅ Election created and posted in ${ch}.`, flags: 64 });
  }
  return interaction.reply({ embeds: [embed] });
}

async function list(interaction, gid) {
  const elections = db.prepare(
    `SELECT * FROM elections WHERE guild_id = ? ORDER BY id DESC LIMIT 20`
  ).all(gid);

  if (!elections.length) return interaction.reply({ embeds: [infoEmbed('🗳️ Elections', 'No elections have been created yet.')] });

  const statusIcon = { registration: '📋', scheduled: '📅', active: '🟢', closed: '🔴', cancelled: '⛔' };
  const lines = elections.map(e =>
    `${statusIcon[e.status] ?? '⚪'} **#${e.id}** — ${e.title} *(${e.office})*`
  );

  return interaction.reply({ embeds: listEmbeds('🗳️ Elections', lines) });
}

async function info(interaction, gid) {
  const id       = interaction.options.getInteger('id');
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election) return replyError(interaction, `Election #${id} not found.`);

  const candidates = db.prepare('SELECT * FROM candidates WHERE election_id = ? ORDER BY votes DESC').all(id);
  const candidateText = candidates.length
    ? candidates.map(c => {
        const party = c.party_id ? db.prepare('SELECT emoji, name FROM parties WHERE id = ?').get(c.party_id) : null;
        return `<@${c.user_id}> — ${c.votes} vote${c.votes !== 1 ? 's' : ''}${party ? ` *(${party.emoji} ${party.name})*` : ''}`;
      }).join('\n')
    : '*No candidates yet.*';

  const voteCount = election.voting_type === 'rcv'
    ? db.prepare('SELECT COUNT(*) as c FROM rcv_votes WHERE election_id = ?').get(id).c
    : db.prepare('SELECT COUNT(*) as c FROM votes WHERE election_id = ?').get(id).c;

  return interaction.reply({ embeds: [
    new EmbedBuilder()
      .setColor(0x5865F2).setTimestamp()
      .setTitle(`🗳️ Election #${id}: ${election.title}`)
      .setDescription(election.description || '')
      .addFields(
        { name: '🏛️ Office',   value: election.office,                                                      inline: true },
        statusField(election.status, election.status === 'registration' ? 'Candidate registration is open' : election.status === 'active' ? 'Voting is open' : 'Voting is closed'),
        { name: '📊 System',   value: election.voting_type === 'rcv' ? 'Ranked Choice' : 'First Past the Post', inline: true },
        { name: '📅 Opens',    value: election.starts_at ? ts(election.starts_at, 'D') : 'Awaiting admin',    inline: true },
        { name: '⏰ Closes',   value: election.starts_at ? ts(election.ends_at) : 'Set when voting opens',    inline: true },
        { name: '🗳️ Votes',   value: `${voteCount}`,                                                        inline: true },
        { name: '🏃 Candidates', value: candidateText },
      ),
  ]});
}

async function open(interaction, gid, uid, client) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return replyError(interaction, 'You need **Manage Server** permission.');
  const id       = interaction.options.getInteger('id');
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election)                            return replyError(interaction, `Election #${id} not found.`);
  if (!['registration','scheduled'].includes(election.status)) return replyError(interaction, 'This election cannot be opened from its current state.');

  const openedAt = now();
  const duration = electionDuration(election);
  db.prepare(`UPDATE elections SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?`)
    .run(openedAt, openedAt + duration, id);
  logActivity(gid, 'ELECTION_OPENED', uid, election.title);
  return interaction.reply({ embeds: [successEmbed('Election Opened', `**${election.title}** is now open for voting!`)] });
}

async function forceClose(interaction, gid, uid, client) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return replyError(interaction, 'You need **Manage Server** permission.');
  const id       = interaction.options.getInteger('id');
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election)                   return replyError(interaction, `Election #${id} not found.`);
  if (election.status !== 'active') return replyError(interaction, 'Only active elections can be closed.');

  await interaction.deferReply();
  const result = await closeElection(client, election);
  if (!result?.closed) return interaction.editReply({ content: '❌ This election was already closed.' });
  logActivity(gid, 'ELECTION_FORCE_CLOSED', uid, election.title);
  return interaction.editReply({ content: `✅ Election **${election.title}** has been closed and results tallied.` });
}

async function cancel(interaction, gid, uid) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return replyError(interaction, 'You need **Manage Server** permission.');
  const id       = interaction.options.getInteger('id');
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election)                     return replyError(interaction, `Election #${id} not found.`);
  if (election.status === 'closed')  return replyError(interaction, 'Cannot cancel a closed election.');

  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE election_id = ?').run(id);
    db.prepare('DELETE FROM rcv_votes WHERE election_id = ?').run(id);
    db.prepare('DELETE FROM candidates WHERE election_id = ?').run(id);
    db.prepare(`UPDATE elections SET status = 'cancelled' WHERE id = ?`).run(id);
  })();
  logActivity(gid, 'ELECTION_CANCELLED', uid, election.title);
  return interaction.reply({ embeds: [successEmbed('Election Cancelled', `Election **#${id} — ${election.title}** has been cancelled.`)] });
}

async function register(interaction, gid, uid) {
  const id       = interaction.options.getInteger('id');
  const platform = interaction.options.getString('platform') ?? '';
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election)                          return replyError(interaction, `Election #${id} not found.`);
  if (election.status !== 'registration') return replyError(interaction, 'This election is not currently accepting registrations.');

  const party = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);

  try {
    db.prepare('INSERT INTO candidates (election_id, user_id, party_id, platform) VALUES (?, ?, ?, ?)')
      .run(id, uid, party?.party_id ?? null, platform);
  } catch {
    return replyError(interaction, 'You are already registered as a candidate in this election.');
  }

  const partyInfo = party
    ? db.prepare('SELECT emoji, name FROM parties WHERE id = ?').get(party.party_id)
    : null;

  logActivity(gid, 'CANDIDATE_REGISTERED', uid, election.title);
  return interaction.reply({ embeds: [
    successEmbed('Candidacy Registered', `You are now running in **${election.title}** for **${election.office}**!\n🏛️ Party: ${partyInfo ? `${partyInfo.emoji} ${partyInfo.name}` : 'Independent'}`)
  ]});
}

async function withdraw(interaction, gid, uid) {
  const id       = interaction.options.getInteger('id');
  const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(id, gid);
  if (!election)                          return replyError(interaction, `Election #${id} not found.`);
  if (election.status === 'closed')       return replyError(interaction, 'Cannot withdraw from a closed election.');

  const candidate = db.prepare('SELECT id FROM candidates WHERE election_id = ? AND user_id = ?').get(id, uid);
  if (!candidate) return replyError(interaction, 'You are not registered in this election.');

  db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE candidate_id = ?').run(candidate.id);
    db.prepare('DELETE FROM candidates WHERE id = ?').run(candidate.id);
  })();
  logActivity(gid, 'CANDIDATE_WITHDREW', uid, election.title);
  return interaction.reply({ embeds: [successEmbed('Candidacy Withdrawn', `You have withdrawn from **${election.title}**.`)], flags: 64 });
}
