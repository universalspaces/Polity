import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity, statusField } from '../utils/embeds.js';
import { castReferendumVote, getReferendumTally } from '../utils/voting.js';
import { referendumResult } from '../utils/governance.js';

export default {
  data: new SlashCommandBuilder()
    .setName('referendum')
    .setDescription('Put a yes/no question directly to all citizens')
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a referendum (Admin only)')
      .addStringOption(o => o.setName('title').setDescription('Question being put to citizens').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Full context and explanation').setRequired(true))
      .addIntegerOption(o => o.setName('hours').setDescription('Voting duration in hours (default: 72)').setMinValue(1).setMaxValue(720)))
    .addSubcommand(s => s
      .setName('vote')
      .setDescription('Cast your vote on a referendum')
      .addIntegerOption(o => o.setName('id').setDescription('Referendum ID').setRequired(true))
      .addStringOption(o => o.setName('vote').setDescription('Your vote').setRequired(true)
        .addChoices(
          { name: '✅ Yes', value: 'yes' },
          { name: '❌ No', value: 'no' },
          { name: '⬛ Abstain', value: 'abstain' }
        )))
    .addSubcommand(s => s
      .setName('close')
      .setDescription('Close a referendum and record result (Admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Referendum ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View referendum details and live tally')
      .addIntegerOption(o => o.setName('id').setDescription('Referendum ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all referendums')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    if (sub === 'create') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      }

      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const hours = interaction.options.getInteger('hours') || 72;
      const now = Math.floor(Date.now() / 1000);
      const endsAt = now + hours * 3600;

      const result = db.prepare(`
        INSERT INTO referendums (guild_id, title, description, created_by, ends_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(gid, title, description, uid, endsAt);

      logActivity(gid, 'REFERENDUM_CREATED', uid, title, `${hours}h`);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🗳️ Referendum Called!')
        .setDescription(`**${title}**\n\n${description}`)
        .addFields(
          { name: '🆔 Referendum ID', value: `#${result.lastInsertRowid}`, inline: true },
          statusField('active', 'Voting is open'),
          { name: '⏰ Closes', value: `<t:${endsAt}:F>`, inline: false }
        )
        .setFooter({ text: 'Use the buttons below to cast your vote' })
        .setTimestamp();

      const voteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ref_vote:${result.lastInsertRowid}:yes`).setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ref_vote:${result.lastInsertRowid}:no`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`ref_vote:${result.lastInsertRowid}:abstain`).setLabel('Abstain').setEmoji('⬛').setStyle(ButtonStyle.Secondary),
      );

      const channel = config?.election_channel
        ? await interaction.guild.channels.fetch(config.election_channel).catch(() => null)
        : null;

      if (channel && channel.id !== interaction.channelId) {
        await channel.send({ embeds: [embed], components: [voteRow] });
        return interaction.reply({ content: `✅ Referendum created and posted in ${channel}!`, flags: 64 });
      }
      return interaction.reply({ embeds: [embed], components: [voteRow] });
    }

    if (sub === 'vote') {
      const id = interaction.options.getInteger('id');
      const vote = interaction.options.getString('vote');
      const result = castReferendumVote(gid, id, uid, vote);
      const voteEmoji = { yes: '✅', no: '❌', abstain: '⬛' };
      if (!result.ok) return interaction.reply({ embeds: [errorEmbed(result.reason)], flags: 64 });
      if (result.changed) {
        return interaction.reply({
          embeds: [successEmbed('Vote Changed', `Changed from **${voteEmoji[result.previous]} ${result.previous.toUpperCase()}** to **${voteEmoji[vote]} ${vote.toUpperCase()}** on Referendum #${id}: **${result.referendum.title}**`, gid)],
          flags: 64
        });
      }
      return interaction.reply({
        embeds: [successEmbed('Vote Recorded', `You voted **${voteEmoji[vote]} ${vote.toUpperCase()}** on Referendum #${id}: **${result.referendum.title}**`, gid)],
        flags: 64
      });
    }

    if (sub === 'close') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      }
      const id = interaction.options.getInteger('id');
      const ref = db.prepare('SELECT * FROM referendums WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!ref) return interaction.reply({ embeds: [errorEmbed(`Referendum #${id} not found.`)], flags: 64 });
      if (ref.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Already closed.')], flags: 64 });

      const tally = getReferendumTally(id);
      const total = tally.yes + tally.no + tally.abstain;
      const result = referendumResult(tally);
      const claimed = db.prepare(`UPDATE referendums SET status = 'closed', result = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'active'`)
        .run(result, tally.yes, tally.no, tally.abstain, id);
      if (claimed.changes !== 1) return interaction.reply({ embeds: [errorEmbed('Already closed.')], flags: 64 });
      logActivity(gid, 'REFERENDUM_CLOSED', uid, ref.title, result.toUpperCase());

      const resultColor = { passed: 0x57f287, failed: 0xed4245, tied: 0xfee75c, no_votes: 0x808080 };
      const resultLabel = { passed: '✅ PASSED', failed: '❌ FAILED', tied: '🟡 TIED', no_votes: '⬛ NO VOTES' };

      const yPct = total > 0 ? ((tally.yes / total) * 100).toFixed(1) : '0.0';
      const nPct = total > 0 ? ((tally.no / total) * 100).toFixed(1) : '0.0';
      const aPct = total > 0 ? ((tally.abstain / total) * 100).toFixed(1) : '0.0';

      const embed = new EmbedBuilder()
        .setColor(resultColor[result] || 0x2f3136)
        .setTitle(`📊 Referendum Closed: ${ref.title}`)
        .setDescription(`**Result: ${resultLabel[result]}**`)
        .addFields(
          { name: '✅ Yes', value: `${tally.yes} (${yPct}%)`, inline: true },
          { name: '❌ No', value: `${tally.no} (${nPct}%)`, inline: true },
          { name: '⬛ Abstain', value: `${tally.abstain} (${aPct}%)`, inline: true },
          { name: '🗳️ Total Votes', value: `${total}`, inline: true }
        )
        .setTimestamp();

      const channel = config?.election_channel
        ? await interaction.guild.channels.fetch(config.election_channel).catch(() => null)
        : null;

      if (channel) await channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'info') {
      const id = interaction.options.getInteger('id');
      const ref = db.prepare('SELECT * FROM referendums WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!ref) return interaction.reply({ embeds: [errorEmbed(`Referendum #${id} not found.`)], flags: 64 });

      const total = ref.votes_yes + ref.votes_no + ref.votes_abstain;
      const yPct = total > 0 ? ((ref.votes_yes / total) * 100).toFixed(1) : '0.0';
      const nPct = total > 0 ? ((ref.votes_no / total) * 100).toFixed(1) : '0.0';
      const aPct = total > 0 ? ((ref.votes_abstain / total) * 100).toFixed(1) : '0.0';

      const statusColor = { active: 0x57f287, closed: 0xed4245 };

      const embed = new EmbedBuilder()
        .setColor(statusColor[ref.status] || 0x5865f2)
        .setTitle(`🗳️ Referendum #${id}: ${ref.title}`)
        .setDescription(ref.description)
        .addFields(
          statusField(ref.status, ref.status === 'active' ? 'Voting is open' : 'Finalized'),
          { name: '📅 Closes', value: `<t:${ref.ends_at}:F>`, inline: true },
          { name: '🗳️ Total Votes', value: `${total}`, inline: true },
          { name: '✅ Yes', value: `${ref.votes_yes} (${yPct}%)`, inline: true },
          { name: '❌ No', value: `${ref.votes_no} (${nPct}%)`, inline: true },
          { name: '⬛ Abstain', value: `${ref.votes_abstain} (${aPct}%)`, inline: true }
        );

      if (ref.result) embed.addFields({ name: '📊 Result', value: ref.result.toUpperCase(), inline: true });

      // Show vote buttons only if the referendum is still active
      if (ref.status === 'active') {
        const voteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ref_vote:${id}:yes`).setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`ref_vote:${id}:no`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`ref_vote:${id}:abstain`).setLabel('Abstain').setEmoji('⬛').setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({ embeds: [embed], components: [voteRow] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const refs = db.prepare('SELECT * FROM referendums WHERE guild_id = ? ORDER BY id DESC LIMIT 15').all(gid);
      if (refs.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🗳️ Referendums').setDescription('No referendums have been called yet.')] });

      const statusEmoji = { active: '🟢', closed: '🔴' };
      const list = refs.map(r => `${statusEmoji[r.status] || '⚪'} **#${r.id}** — ${r.title} *(${r.votes_yes}Y / ${r.votes_no}N)*`).join('\n');
      return interaction.reply({ embeds: listEmbeds('🗳️ Referendums', list.split('\n')) });
    }
  }
};
