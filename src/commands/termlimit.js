import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, logActivity } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('termlimit')
    .setDescription('Manage term limits for government offices')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Set a term limit for an office (Admin only)')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true))
      .addIntegerOption(o => o.setName('max_terms').setDescription('Maximum number of terms allowed').setRequired(true).setMinValue(1).setMaxValue(99)))
    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Remove a term limit from an office (Admin only)')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('View all term limits and current term counts'))
    .addSubcommand(s => s
      .setName('check')
      .setDescription('Check how many terms a citizen has served')
      .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true))
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'set') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }
      const office = interaction.options.getString('office');
      const maxTerms = interaction.options.getInteger('max_terms');

      // Verify office exists
      const officeRecord = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?)').get(gid, office);
      if (!officeRecord) return interaction.reply({ embeds: [errorEmbed(`Office **${office}** not found. Create it first with \`/office create\`.`)], flags: 64 });

      db.prepare(`
        INSERT INTO term_limits (guild_id, office_name, max_terms)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id, office_name) DO UPDATE SET max_terms = excluded.max_terms
      `).run(gid, officeRecord.name, maxTerms);

      logActivity(gid, 'TERM_LIMIT_SET', uid, officeRecord.name, `${maxTerms} terms`);
      return interaction.reply({
        embeds: [successEmbed('Term Limit Set',
          `**${officeRecord.name}** is now limited to **${maxTerms} term${maxTerms !== 1 ? 's' : ''}**.`,
          gid
        )]
      });
    }

    if (sub === 'remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }
      const office = interaction.options.getString('office');
      const result = db.prepare('DELETE FROM term_limits WHERE guild_id = ? AND LOWER(office_name) = LOWER(?)').run(gid, office);
      if (result.changes === 0) return interaction.reply({ embeds: [errorEmbed(`No term limit found for **${office}**.`)], flags: 64 });
      return interaction.reply({ embeds: [successEmbed('Term Limit Removed', `Term limit for **${office}** has been removed.`, gid)] });
    }

    if (sub === 'list') {
      const limits = db.prepare('SELECT * FROM term_limits WHERE guild_id = ? ORDER BY office_name').all(gid);
      if (limits.length === 0) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('📋 Term Limits')
            .setDescription('No term limits have been configured.\n\nUse `/termlimit set` to add one.')]
        });
      }

      const fields = limits.map(l => {
        const office = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND name = ?').get(gid, l.office_name);
        const holderTerms = office?.holder_id
          ? db.prepare('SELECT COUNT(*) as cnt FROM office_history WHERE guild_id = ? AND office_name = ? AND user_id = ?')
              .get(gid, l.office_name, office.holder_id).cnt
          : 0;

        return {
          name: `💼 ${l.office_name}`,
          value: `Max: **${l.max_terms}** term${l.max_terms !== 1 ? 's' : ''}${office?.holder_id ? `\nCurrent holder: <@${office.holder_id}> (${holderTerms + 1} term${holderTerms + 1 !== 1 ? 's' : ''})` : '\n*Vacant*'}`,
          inline: true
        };
      });

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📋 Term Limits')
          .addFields(fields)]
      });
    }

    if (sub === 'check') {
      const target = interaction.options.getUser('user');
      const office = interaction.options.getString('office');

      const history = db.prepare('SELECT * FROM office_history WHERE guild_id = ? AND LOWER(office_name) = LOWER(?) AND user_id = ? ORDER BY assumed_at DESC')
        .all(gid, office, target.id);

      const limit = db.prepare('SELECT * FROM term_limits WHERE guild_id = ? AND LOWER(office_name) = LOWER(?)').get(gid, office);
      const currentlyHolding = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND holder_id = ?').get(gid, office, target.id);

      const totalTerms = history.length + (currentlyHolding ? 1 : 0);
      const isEligible = !limit || totalTerms < limit.max_terms;

      const embed = new EmbedBuilder()
        .setColor(isEligible ? 0x57f287 : 0xed4245)
        .setTitle(`📋 Term Record: ${target.username}`)
        .addFields(
          { name: '💼 Office', value: office, inline: true },
          { name: '📊 Terms Served', value: `${totalTerms}${currentlyHolding ? ' (currently serving)' : ''}`, inline: true },
          { name: '🔢 Term Limit', value: limit ? `${limit.max_terms}` : 'None', inline: true },
          { name: '✅ Eligible to Run', value: isEligible ? 'Yes' : `No — has reached the ${limit?.max_terms}-term limit`, inline: false }
        );

      if (history.length > 0) {
        const historyText = history.slice(0, 5).map(h =>
          `• <t:${h.assumed_at}:D> → ${h.vacated_at ? `<t:${h.vacated_at}:D>` : '*present*'} *(${h.reason})*`
        ).join('\n');
        embed.addFields({ name: '📅 Term History', value: historyText });
      }

      return interaction.reply({ embeds: [embed] });
    }
  }
};
