import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity, statusField } from '../utils/embeds.js';

// Number emoji for up to 10 options
const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

function buildResultsEmbed(poll, votes, sym) {
  const options = JSON.parse(poll.options);
  const totalVotes = votes.length;

  // Count per option
  const counts = new Array(options.length).fill(0);
  for (const v of votes) counts[v.option_index]++;

  const sorted = options
    .map((opt, i) => ({ opt, i, count: counts[i] }))
    .sort((a, b) => b.count - a.count);

  const lines = sorted.map(({ opt, i, count }) => {
    const pct = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : '0.0';
    const filled = Math.round(parseFloat(pct) / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `${NUM_EMOJI[i]} **${opt}**\n\`${bar}\` ${count} vote${count !== 1 ? 's' : ''} (${pct}%)`;
  });

  const statusColor = poll.status === 'active' ? 0x5865f2 : 0x57f287;

  return new EmbedBuilder()
    .setColor(statusColor)
    .setTitle(`${sym} Poll: ${poll.title}`)
    .setDescription((poll.description ? poll.description + '\n\n' : '') + lines.join('\n\n'))
    .addFields(
      { name: '🗳️ Total Votes', value: `${totalVotes}`, inline: true },
      statusField(poll.status, poll.status === 'active' ? 'Voting is open' : 'Finalized'),
      { name: '🔒 Anonymous', value: poll.anonymous ? 'Yes' : 'No', inline: true },
      ...(poll.ends_at && poll.status === 'active' ? [{ name: '⏰ Closes', value: `<t:${poll.ends_at}:R>`, inline: true }] : [])
    )
    .setFooter({ text: `Poll #${poll.id} · Use /poll vote to cast your vote` })
    .setTimestamp();
}

export default {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create and manage informal polls')
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a new poll')
      .addStringOption(o => o.setName('title').setDescription('Poll question').setRequired(true))
      .addStringOption(o => o.setName('option1').setDescription('Option 1').setRequired(true))
      .addStringOption(o => o.setName('option2').setDescription('Option 2').setRequired(true))
      .addStringOption(o => o.setName('option3').setDescription('Option 3'))
      .addStringOption(o => o.setName('option4').setDescription('Option 4'))
      .addStringOption(o => o.setName('option5').setDescription('Option 5'))
      .addStringOption(o => o.setName('option6').setDescription('Option 6'))
      .addStringOption(o => o.setName('option7').setDescription('Option 7'))
      .addStringOption(o => o.setName('option8').setDescription('Option 8'))
      .addStringOption(o => o.setName('option9').setDescription('Option 9'))
      .addStringOption(o => o.setName('option10').setDescription('Option 10'))
      .addStringOption(o => o.setName('description').setDescription('Optional context or description'))
      .addIntegerOption(o => o.setName('hours').setDescription('Auto-close after this many hours (omit for no deadline)').setMinValue(1).setMaxValue(720))
      .addBooleanOption(o => o.setName('anonymous').setDescription('Hide who voted for what (default: false)')))
    .addSubcommand(s => s
      .setName('vote')
      .setDescription('Cast your vote on a poll')
      .addIntegerOption(o => o.setName('poll_id').setDescription('Poll ID').setRequired(true))
      .addIntegerOption(o => o.setName('option').setDescription('Option number (1–10)').setRequired(true).setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View poll results')
      .addIntegerOption(o => o.setName('poll_id').setDescription('Poll ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all polls'))
    .addSubcommand(s => s
      .setName('close')
      .setDescription('Close a poll early (creator or Admin)')
      .addIntegerOption(o => o.setName('poll_id').setDescription('Poll ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('voters')
      .setDescription('See who voted for what (non-anonymous polls only)')
      .addIntegerOption(o => o.setName('poll_id').setDescription('Poll ID').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    if (sub === 'create') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description') || null;
      const hours = interaction.options.getInteger('hours');
      const anonymous = interaction.options.getBoolean('anonymous') || false;

      const optionKeys = ['option1','option2','option3','option4','option5','option6','option7','option8','option9','option10'];
      const options = optionKeys.map(k => interaction.options.getString(k)).filter(Boolean);

      if (options.length < 2) {
        return interaction.reply({ embeds: [errorEmbed('You must provide at least 2 options.')], flags: 64 });
      }

      const now = Math.floor(Date.now() / 1000);
      const endsAt = hours ? now + hours * 3600 : null;

      const result = db.prepare(`
        INSERT INTO polls (guild_id, title, description, created_by, options, ends_at, anonymous)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(gid, title, description, uid, JSON.stringify(options), endsAt, anonymous ? 1 : 0);

      logActivity(gid, 'POLL_CREATED', uid, title, `${options.length} options`);

      const optionLines = options.map((o, i) => `${NUM_EMOJI[i]} ${o}`).join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📊 New Poll: ${title}`)
        .setDescription((description ? description + '\n\n' : '') + optionLines)
        .addFields(
          { name: '🆔 Poll ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '🔒 Anonymous', value: anonymous ? 'Yes' : 'No', inline: true },
          ...(endsAt ? [{ name: '⏰ Closes', value: `<t:${endsAt}:F>`, inline: true }] : [{ name: '⏰ Closes', value: 'No deadline', inline: true }])
        )
        .setFooter({ text: `Poll #${result.lastInsertRowid} · Select an option below to vote` })
        .setTimestamp();

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`poll_vote:${result.lastInsertRowid}`)
        .setPlaceholder('Cast your vote…')
        .addOptions(options.map((opt, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${opt.substring(0, 97)}`)
            .setValue(String(i))
            .setEmoji(NUM_EMOJI[i])
        ));
      const voteRow = new ActionRowBuilder().addComponents(selectMenu);

      // Post to election channel if configured, otherwise reply in-channel
      const channel = config?.election_channel
        ? await interaction.guild.channels.fetch(config.election_channel).catch(() => null)
        : null;

      if (channel && channel.id !== interaction.channelId) {
        const msg = await channel.send({ embeds: [embed], components: [voteRow] });
        db.prepare('UPDATE polls SET message_id = ?, channel_id = ? WHERE id = ?')
          .run(msg.id, channel.id, result.lastInsertRowid);
        return interaction.reply({ content: `✅ Poll created and posted in ${channel}!`, flags: 64 });
      }

      const msg = await interaction.reply({ embeds: [embed], components: [voteRow], fetchReply: true });
      db.prepare('UPDATE polls SET message_id = ?, channel_id = ? WHERE id = ?')
        .run(msg.id, interaction.channelId, result.lastInsertRowid);
      return;
    }

    if (sub === 'vote') {
      const pollId = interaction.options.getInteger('poll_id');
      const optionNum = interaction.options.getInteger('option');
      const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(pollId, gid);

      if (!poll) return interaction.reply({ embeds: [errorEmbed(`Poll #${pollId} not found.`)], flags: 64 });
      if (poll.status !== 'active') return interaction.reply({ embeds: [errorEmbed('This poll is no longer open.')], flags: 64 });

      const now = Math.floor(Date.now() / 1000);
      if (poll.ends_at && now > poll.ends_at) {
        db.prepare(`UPDATE polls SET status = 'closed' WHERE id = ?`).run(pollId);
        return interaction.reply({ embeds: [errorEmbed('This poll has already closed.')], flags: 64 });
      }

      const options = JSON.parse(poll.options);
      const optionIndex = optionNum - 1;
      if (optionIndex < 0 || optionIndex >= options.length) {
        return interaction.reply({ embeds: [errorEmbed(`Invalid option. This poll has ${options.length} options (1–${options.length}).`)], flags: 64 });
      }

      const existing = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? AND voter_id = ?').get(pollId, uid);
      if (existing) {
        if (existing.option_index === optionIndex) {
          return interaction.reply({ embeds: [errorEmbed(`You already voted for **${options[optionIndex]}**.`)], flags: 64 });
        }
        // Allow changing vote
        db.prepare('UPDATE poll_votes SET option_index = ?, voted_at = ? WHERE poll_id = ? AND voter_id = ?')
          .run(optionIndex, now, pollId, uid);
        const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').all(pollId);
        const embed = buildResultsEmbed(poll, votes, '📊')
          .setTitle(`📊 Vote Changed — ${poll.title}`)
          .setDescription(`Changed from **${options[existing.option_index]}** to **${options[optionIndex]}**.\n\n${buildResultsEmbed(poll, votes, '📊').data.description}`);
        return interaction.reply({
          embeds: [embed],
          flags: 64
        });
      }

      db.prepare('INSERT INTO poll_votes (poll_id, voter_id, option_index) VALUES (?, ?, ?)').run(pollId, uid, optionIndex);
      const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').all(pollId);
      const embed = buildResultsEmbed(poll, votes, '📊')
        .setTitle(`📊 Vote Cast — ${poll.title}`);
      return interaction.reply({
        embeds: [embed],
        flags: 64
      });
    }

    if (sub === 'info') {
      const pollId = interaction.options.getInteger('poll_id');
      const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(pollId, gid);
      if (!poll) return interaction.reply({ embeds: [errorEmbed(`Poll #${pollId} not found.`)], flags: 64 });

      const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').all(pollId);
      const embed = buildResultsEmbed(poll, votes, '📊');

      if (poll.status === 'active') {
        const options = JSON.parse(poll.options);
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`poll_vote:${pollId}`)
          .setPlaceholder('Cast or change your vote…')
          .addOptions(options.map((opt, i) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${i + 1}. ${opt.substring(0, 97)}`)
              .setValue(String(i))
              .setEmoji(NUM_EMOJI[i])
          ));
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const polls = db.prepare(`
        SELECT p.*, COUNT(pv.voter_id) as vote_count
        FROM polls p
        LEFT JOIN poll_votes pv ON p.id = pv.poll_id
        WHERE p.guild_id = ?
        GROUP BY p.id
        ORDER BY p.id DESC LIMIT 15
      `).all(gid);

      if (polls.length === 0) {
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Polls').setDescription('No polls have been created yet.')] });
      }

      const statusEmoji = { active: '🟢', closed: '🔴' };
      const list = polls.map(p =>
        `${statusEmoji[p.status] || '⚪'} **#${p.id}** — ${p.title} *(${p.vote_count} vote${p.vote_count !== 1 ? 's' : ''})*`
      ).join('\n');

      return interaction.reply({ embeds: listEmbeds('📊 Polls', list.split('\n')) });
    }

    if (sub === 'close') {
      const pollId = interaction.options.getInteger('poll_id');
      const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(pollId, gid);
      if (!poll) return interaction.reply({ embeds: [errorEmbed(`Poll #${pollId} not found.`)], flags: 64 });
      if (poll.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Poll is already closed.')], flags: 64 });

      const isCreator = poll.created_by === uid;
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
      if (!isCreator && !isAdmin) {
        return interaction.reply({ embeds: [errorEmbed('Only the poll creator or an admin can close this poll.')], flags: 64 });
      }

      db.prepare(`UPDATE polls SET status = 'closed' WHERE id = ?`).run(pollId);
      logActivity(gid, 'POLL_CLOSED', uid, poll.title, '');

      const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').all(pollId);
      const embed = buildResultsEmbed({ ...poll, status: 'closed' }, votes, '📊');
      embed.setTitle(`📊 Poll Closed: ${poll.title}`);

      // Update the original message if we have it
      if (poll.message_id && poll.channel_id) {
        try {
          const chan = await interaction.guild.channels.fetch(poll.channel_id);
          const msg = await chan.messages.fetch(poll.message_id);
          await msg.edit({ embeds: [embed] });
        } catch (e) { /* message may have been deleted */ }
      }

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'voters') {
      const pollId = interaction.options.getInteger('poll_id');
      const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(pollId, gid);
      if (!poll) return interaction.reply({ embeds: [errorEmbed(`Poll #${pollId} not found.`)], flags: 64 });
      if (poll.anonymous) return interaction.reply({ embeds: [errorEmbed('This poll is anonymous — voter breakdown is hidden.')], flags: 64 });

      const options = JSON.parse(poll.options);
      const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY option_index').all(pollId);

      if (votes.length === 0) {
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 Voters — ${poll.title}`).setDescription('No votes cast yet.')] });
      }

      const grouped = options.map((opt, i) => {
        const optVoters = votes.filter(v => v.option_index === i);
        return optVoters.length > 0
          ? `${NUM_EMOJI[i]} **${opt}** (${optVoters.length})\n${optVoters.map(v => `<@${v.voter_id}>`).join(', ')}`
          : `${NUM_EMOJI[i]} **${opt}** — *no votes*`;
      }).join('\n\n');

      return interaction.reply({
        embeds: listEmbeds(`📊 Voter Breakdown — ${poll.title}`, grouped.split('\n\n')),
        flags: 64
      });
    }
  }
};
