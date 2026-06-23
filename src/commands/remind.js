import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a DM reminder before an election closes')
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Get a DM reminder before an election closes')
      .addIntegerOption(o => o.setName('election_id').setDescription('Election ID').setRequired(true))
      .addIntegerOption(o => o.setName('hours_before').setDescription('Hours before close to remind you (default: 2)').setMinValue(1).setMaxValue(48)))
    .addSubcommand(s => s
      .setName('cancel')
      .setDescription('Cancel a reminder')
      .addIntegerOption(o => o.setName('election_id').setDescription('Election ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('View your active reminders')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'set') {
      const electionId = interaction.options.getInteger('election_id');
      const hoursBefore = interaction.options.getInteger('hours_before') || 2;

      const election = db.prepare('SELECT * FROM elections WHERE id = ? AND guild_id = ?').get(electionId, gid);
      if (!election) return interaction.reply({ embeds: [errorEmbed(`Election #${electionId} not found.`)], flags: 64 });
      if (!['registration', 'active'].includes(election.status)) {
        return interaction.reply({ embeds: [errorEmbed('You can only set reminders for upcoming or active elections.')], flags: 64 });
      }

      const remindAt = election.ends_at - (hoursBefore * 3600);
      const now = Math.floor(Date.now() / 1000);
      if (remindAt <= now) {
        return interaction.reply({ embeds: [errorEmbed(`That reminder would be in the past. The election closes <t:${election.ends_at}:R>.`)], flags: 64 });
      }

      db.prepare(`
        INSERT INTO election_reminders (guild_id, user_id, election_id, remind_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id, election_id) DO UPDATE SET remind_at = excluded.remind_at, sent = 0
      `).run(gid, uid, electionId, remindAt);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('⏰ Reminder Set!')
          .setDescription(`You'll receive a DM **${hoursBefore} hour${hoursBefore !== 1 ? 's' : ''}** before **${election.title}** closes.`)
          .addFields(
            { name: '⏰ Reminder at', value: `<t:${remindAt}:F>`, inline: true },
            { name: '🗳️ Election closes', value: `<t:${election.ends_at}:F>`, inline: true }
          )],
        flags: 64
      });
    }

    if (sub === 'cancel') {
      const electionId = interaction.options.getInteger('election_id');
      const result = db.prepare('DELETE FROM election_reminders WHERE guild_id = ? AND user_id = ? AND election_id = ?').run(gid, uid, electionId);
      if (result.changes === 0) return interaction.reply({ embeds: [errorEmbed('No reminder found for that election.')], flags: 64 });
      return interaction.reply({ embeds: [successEmbed('Reminder Cancelled', `Reminder for election #${electionId} removed.`, gid)], flags: 64 });
    }

    if (sub === 'list') {
      const reminders = db.prepare(`
        SELECT r.*, e.title, e.ends_at FROM election_reminders r
        JOIN elections e ON r.election_id = e.id
        WHERE r.guild_id = ? AND r.user_id = ? AND r.sent = 0
        ORDER BY r.remind_at ASC
      `).all(gid, uid);

      if (reminders.length === 0) {
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⏰ Your Reminders').setDescription('You have no active reminders.')], flags: 64 });
      }

      const list = reminders.map(r => `📌 **${r.title}** — reminding <t:${r.remind_at}:R>`).join('\n');
      return interaction.reply({ embeds: listEmbeds('⏰ Your Active Reminders', list.split('\n')), flags: 64 });
    }
  }
};
