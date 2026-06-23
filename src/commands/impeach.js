import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity } from '../utils/embeds.js';
import { castImpeachmentVote, getImpeachmentTally } from '../utils/voting.js';

export default {
  data: new SlashCommandBuilder()
    .setName('impeach')
    .setDescription('Impeachment proceedings against a government official')
    .addSubcommand(s => s
      .setName('file')
      .setDescription('File articles of impeachment against an officeholder (Admin only)')
      .addUserOption(o => o.setName('official').setDescription('The official to impeach').setRequired(true))
      .addStringOption(o => o.setName('office').setDescription('The office they hold').setRequired(true))
      .addStringOption(o => o.setName('charges').setDescription('Articles of impeachment / charges').setRequired(true)))
    .addSubcommand(s => s
      .setName('vote')
      .setDescription('Vote to convict or acquit in an impeachment trial')
      .addIntegerOption(o => o.setName('id').setDescription('Impeachment ID').setRequired(true))
      .addStringOption(o => o.setName('vote').setDescription('Your vote').setRequired(true)
        .addChoices(
          { name: '⚖️ Convict (remove from office)', value: 'convict' },
          { name: '🛡️ Acquit (keep in office)', value: 'acquit' },
          { name: '⬛ Abstain', value: 'abstain' }
        )))
    .addSubcommand(s => s
      .setName('conclude')
      .setDescription('Conclude an impeachment trial and tally the result (Admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Impeachment ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View impeachment trial details')
      .addIntegerOption(o => o.setName('id').setDescription('Impeachment ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all impeachment proceedings')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    if (sub === 'file') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions to file impeachment.')], flags: 64 });
      }

      const official = interaction.options.getUser('official');
      const office = interaction.options.getString('office');
      const charges = interaction.options.getString('charges');

      // Verify the official actually holds that office
      const officeRecord = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND holder_id = ?').get(gid, office, official.id);
      if (!officeRecord) {
        return interaction.reply({ embeds: [errorEmbed(`<@${official.id}> does not hold the office of **${office}**. Verify with \`/office list\`.`)], flags: 64 });
      }

      // Check for existing active trial
      const existing = db.prepare(`SELECT * FROM impeachments WHERE guild_id = ? AND target_id = ? AND status = 'trial'`).get(gid, official.id);
      if (existing) {
        return interaction.reply({ embeds: [errorEmbed(`There is already an active impeachment trial against <@${official.id}> (Case #${existing.id}).`)], flags: 64 });
      }

      const result = db.prepare(`
        INSERT INTO impeachments (guild_id, target_id, office, charges, brought_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(gid, official.id, office, charges, uid);

      logActivity(gid, 'IMPEACHMENT_FILED', uid, official.id, `Office: ${office}`);

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚖️ Articles of Impeachment Filed')
        .setDescription(`The following charges have been brought against <@${official.id}>:`)
        .addFields(
          { name: '🆔 Proceeding ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '💼 Office', value: office, inline: true },
          { name: '👤 Brought By', value: `<@${uid}>`, inline: true },
          { name: '📜 Charges', value: charges },
          { name: '📋 Status', value: 'TRIAL IN PROGRESS', inline: true }
        )
        .setFooter({ text: 'Use the buttons below to cast your verdict' })
        .setTimestamp();

      const voteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`imp_vote:${result.lastInsertRowid}:convict`).setLabel('Convict').setEmoji('⚖️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`imp_vote:${result.lastInsertRowid}:acquit`).setLabel('Acquit').setEmoji('🛡️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`imp_vote:${result.lastInsertRowid}:abstain`).setLabel('Abstain').setEmoji('⬛').setStyle(ButtonStyle.Secondary),
      );

      const channel = config?.announcement_channel
        ? await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null)
        : null;

      if (channel && channel.id !== interaction.channelId) {
        await channel.send({ embeds: [embed], components: [voteRow] });
        return interaction.reply({ content: `⚖️ Impeachment filed and announced in ${channel}!`, flags: 64 });
      }
      return interaction.reply({ embeds: [embed], components: [voteRow] });
    }

    if (sub === 'vote') {
      const id = interaction.options.getInteger('id');
      const vote = interaction.options.getString('vote');
      const result = castImpeachmentVote(gid, id, uid, vote);
      if (!result.ok) return interaction.reply({ embeds: [errorEmbed(result.reason)], flags: 64 });

      const voteLabel = { convict: '⚖️ CONVICT', acquit: '🛡️ ACQUIT', abstain: '⬛ ABSTAIN' };
      return interaction.reply({
        embeds: [successEmbed('Vote Recorded', `You voted **${voteLabel[vote]}** in the impeachment trial of <@${result.proceeding.target_id}>.`, gid)],
        flags: 64
      });
    }

    if (sub === 'conclude') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      }

      const id = interaction.options.getInteger('id');
      const proceeding = db.prepare('SELECT * FROM impeachments WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!proceeding) return interaction.reply({ embeds: [errorEmbed(`Impeachment #${id} not found.`)], flags: 64 });
      if (proceeding.status !== 'trial') return interaction.reply({ embeds: [errorEmbed('This trial has already concluded.')], flags: 64 });

      const tally = getImpeachmentTally(id);
      const total = tally.convict + tally.acquit + tally.abstain;
      // Conviction requires a majority of convict+acquit votes (ignoring abstentions)
      const decisive = tally.convict + tally.acquit;
      const convicted = decisive > 0 && tally.convict > tally.acquit;
      const outcome = convicted ? 'convicted' : 'acquitted';

      const now = Math.floor(Date.now() / 1000);
      const officeRecord = convicted
        ? db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND holder_id = ?')
            .get(gid, proceeding.office, proceeding.target_id)
        : null;
      const committed = db.transaction(() => {
        const updated = db.prepare(`UPDATE impeachments SET status = ?, concluded_at = ?, votes_convict = ?, votes_acquit = ?, votes_abstain = ? WHERE id = ? AND status = 'trial'`)
          .run(outcome, now, tally.convict, tally.acquit, tally.abstain, id);
        if (updated.changes !== 1) return false;
        if (officeRecord) {
          db.prepare('INSERT INTO office_history (guild_id, office_name, user_id, assumed_at, vacated_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
            .run(gid, officeRecord.name, proceeding.target_id, officeRecord.assumed_at ?? now, now, 'impeachment');
          db.prepare('UPDATE offices SET holder_id = NULL, assumed_at = NULL WHERE id = ?').run(officeRecord.id);
        }
        logActivity(gid, 'IMPEACHMENT_CONCLUDED', uid, proceeding.target_id, outcome.toUpperCase());
        return true;
      })();
      if (!committed) return interaction.reply({ embeds: [errorEmbed('This trial has already concluded.')], flags: 64 });

      const cPct = decisive > 0 ? ((tally.convict / decisive) * 100).toFixed(1) : '0.0';
      const aPct = decisive > 0 ? ((tally.acquit / decisive) * 100).toFixed(1) : '0.0';

      const embed = new EmbedBuilder()
        .setColor(convicted ? 0xed4245 : 0x57f287)
        .setTitle(`⚖️ Impeachment Trial Concluded — #${id}`)
        .setDescription(convicted
          ? `**<@${proceeding.target_id}> has been CONVICTED** and removed from the office of **${proceeding.office}**.`
          : `**<@${proceeding.target_id}> has been ACQUITTED** and retains the office of **${proceeding.office}**.`)
        .addFields(
          { name: '⚖️ Convict', value: `${tally.convict} (${cPct}%)`, inline: true },
          { name: '🛡️ Acquit', value: `${tally.acquit} (${aPct}%)`, inline: true },
          { name: '⬛ Abstain', value: `${tally.abstain}`, inline: true },
          { name: '🗳️ Total Votes', value: `${total}`, inline: true },
          { name: '📜 Original Charges', value: proceeding.charges }
        )
        .setTimestamp();

      // If convicted, remove from office
      if (convicted) {
        // Remove role if configured
        if (officeRecord?.role_id) {
          try {
            const member = await interaction.guild.members.fetch(proceeding.target_id);
            await member.roles.remove(officeRecord.role_id);
          } catch (error) {
            console.warn(`[ROLE SYNC] Failed to remove role ${officeRecord.role_id} after impeachment ${id}:`, error);
            embed.addFields({ name: '⚠️ Role Sync', value: 'The office was vacated, but the Discord role could not be removed. Check the bot role hierarchy and permissions.' });
          }
        }
      }

      const channel = config?.announcement_channel
        ? await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null)
        : null;

      if (channel) await channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'info') {
      const id = interaction.options.getInteger('id');
      const p = db.prepare('SELECT * FROM impeachments WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!p) return interaction.reply({ embeds: [errorEmbed(`Impeachment #${id} not found.`)], flags: 64 });

      const total = p.votes_convict + p.votes_acquit + p.votes_abstain;
      const decisive = p.votes_convict + p.votes_acquit;
      const cPct = decisive > 0 ? ((p.votes_convict / decisive) * 100).toFixed(1) : '0.0';
      const aPct = decisive > 0 ? ((p.votes_acquit / decisive) * 100).toFixed(1) : '0.0';

      const statusColor = { trial: 0xed4245, convicted: 0xed4245, acquitted: 0x57f287 };

      const embed = new EmbedBuilder()
        .setColor(statusColor[p.status] || 0x2f3136)
        .setTitle(`⚖️ Impeachment #${id}`)
        .addFields(
          { name: '🎯 Official', value: `<@${p.target_id}>`, inline: true },
          { name: '💼 Office', value: p.office, inline: true },
          { name: '📋 Status', value: p.status.toUpperCase(), inline: true },
          { name: '👤 Filed By', value: `<@${p.brought_by}>`, inline: true },
          { name: '📅 Filed', value: `<t:${p.filed_at}:D>`, inline: true },
          { name: '📜 Charges', value: p.charges },
          { name: '⚖️ Convict', value: `${p.votes_convict} (${cPct}%)`, inline: true },
          { name: '🛡️ Acquit', value: `${p.votes_acquit} (${aPct}%)`, inline: true },
          { name: '⬛ Abstain', value: `${p.votes_abstain} / ${total} total`, inline: true }
        );

      if (p.status === 'trial') {
        const voteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`imp_vote:${id}:convict`).setLabel('Convict').setEmoji('⚖️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`imp_vote:${id}:acquit`).setLabel('Acquit').setEmoji('🛡️').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`imp_vote:${id}:abstain`).setLabel('Abstain').setEmoji('⬛').setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({ embeds: [embed], components: [voteRow] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const proceedings = db.prepare('SELECT * FROM impeachments WHERE guild_id = ? ORDER BY id DESC LIMIT 15').all(gid);
      if (proceedings.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚖️ Impeachments').setDescription('No impeachment proceedings on record.')] });

      const statusEmoji = { trial: '🔴', convicted: '⛓️', acquitted: '🛡️' };
      const list = proceedings.map(p => `${statusEmoji[p.status] || '⚪'} **#${p.id}** — <@${p.target_id}> *(${p.office})* — ${p.status.toUpperCase()}`).join('\n');
      return interaction.reply({ embeds: listEmbeds('⚖️ Impeachment Proceedings', list.split('\n')) });
    }
  }
};
