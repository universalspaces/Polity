import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity } from '../utils/embeds.js';
import { getReferendumTally } from '../utils/voting.js';
import { referendumResult } from '../utils/governance.js';

function logAdmin(gid, adminId, action, target, reason, details = '') {
  db.prepare('INSERT INTO admin_log (guild_id, admin_id, action, target, reason, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(gid, adminId, action, target, reason, details);
  logActivity(gid, `ADMIN_${action}`, adminId, target, reason);
}

export default {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Administrative moderation tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s
      .setName('auditlog')
      .setDescription('View the admin action audit log')
      .addIntegerOption(o => o.setName('limit').setDescription('Number of entries (default 15)').setMinValue(1).setMaxValue(50))
      .addUserOption(o => o.setName('filter_admin').setDescription('Filter by a specific admin')))
    .addSubcommand(s => s
      .setName('reset_citizen')
      .setDescription('Remove a citizen\'s registration from this server')
      .addUserOption(o => o.setName('user').setDescription('Citizen to remove').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('remove_party_member')
      .setDescription('Remove a user from their party')
      .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('dismiss_case')
      .setDescription('Dismiss a court case')
      .addIntegerOption(o => o.setName('case_id').setDescription('Case ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for dismissal').setRequired(true)))
    .addSubcommand(s => s
      .setName('close_referendum')
      .setDescription('Force close a referendum and set result')
      .addIntegerOption(o => o.setName('id').setDescription('Referendum ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('expire_initiative')
      .setDescription('Mark an initiative as expired')
      .addIntegerOption(o => o.setName('id').setDescription('Initiative ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('set_reputation')
      .setDescription('Directly set a citizen\'s reputation to a specific value')
      .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
      .addIntegerOption(o => o.setName('value').setDescription('New reputation value').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('announce')
      .setDescription('Send an official government announcement')
      .addStringOption(o => o.setName('title').setDescription('Announcement title').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Announcement body').setRequired(true))
      .addStringOption(o => o.setName('color').setDescription('Embed color hex (default: blue)'))
      .addBooleanOption(o => o.setName('ping_everyone').setDescription('Ping @everyone (default: false)')))
    .addSubcommand(s => s
      .setName('purge_elections')
      .setDescription('Delete all cancelled/old closed elections older than N days')
      .addIntegerOption(o => o.setName('days').setDescription('Delete elections closed more than N days ago').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s
      .setName('server_stats')
      .setDescription('View detailed server statistics and health check')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'auditlog') {
      const limit = interaction.options.getInteger('limit') || 15;
      const filterAdmin = interaction.options.getUser('filter_admin');

      const entries = filterAdmin
        ? db.prepare('SELECT * FROM admin_log WHERE guild_id = ? AND admin_id = ? ORDER BY id DESC LIMIT ?').all(gid, filterAdmin.id, limit)
        : db.prepare('SELECT * FROM admin_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(gid, limit);

      if (entries.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Admin Audit Log').setDescription('No admin actions recorded yet.')], flags: 64 });

      const list = entries.map(e =>
        `\`${e.action}\` by <@${e.admin_id}>${e.target ? ` → \`${e.target}\`` : ''}${e.reason ? ` — *${e.reason}*` : ''} <t:${e.logged_at}:D>`
      ).join('\n');

      return interaction.reply({
        embeds: listEmbeds(`📋 Admin Audit Log${filterAdmin ? ` — ${filterAdmin.username}` : ''}`, list.split('\n')),
        flags: 64,
      });
    }

    if (sub === 'reset_citizen') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed(`${target.username} is not a registered citizen.`)], flags: 64 });

      // Remove from party if in one
      const partyMembership = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (partyMembership) db.prepare('DELETE FROM party_members WHERE guild_id = ? AND user_id = ?').run(gid, target.id);

      db.prepare('DELETE FROM citizens WHERE guild_id = ? AND user_id = ?').run(gid, target.id);
      logAdmin(gid, uid, 'CITIZEN_RESET', target.id, reason);

      return interaction.reply({ embeds: [successEmbed('Citizen Removed',
        `<@${target.id}> has been de-registered as a citizen.\n**Reason:** ${reason}`, gid)] });
    }

    if (sub === 'remove_party_member') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const membership = db.prepare('SELECT pm.*, p.name, p.leader_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.guild_id = ? AND pm.user_id = ?').get(gid, target.id);
      if (!membership) return interaction.reply({ embeds: [errorEmbed(`${target.username} is not in any party.`)], flags: 64 });

      db.prepare('DELETE FROM party_members WHERE guild_id = ? AND user_id = ?').run(gid, target.id);
      logAdmin(gid, uid, 'PARTY_MEMBER_REMOVED', target.id, reason, membership.name);

      return interaction.reply({ embeds: [successEmbed('Party Member Removed',
        `<@${target.id}> has been removed from **${membership.name}**.\n**Reason:** ${reason}`, gid)] });
    }

    if (sub === 'dismiss_case') {
      const caseId = interaction.options.getInteger('case_id');
      const reason = interaction.options.getString('reason');
      const courtCase = db.prepare('SELECT * FROM cases WHERE id = ? AND guild_id = ?').get(caseId, gid);
      if (!courtCase) return interaction.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)], flags: 64 });
      if (courtCase.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Case is already closed.')], flags: 64 });

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`UPDATE cases SET status = 'closed', verdict = 'dismissed', ruling = ?, ruled_at = ? WHERE id = ?`)
        .run(`Dismissed by admin: ${reason}`, now, caseId);
      logAdmin(gid, uid, 'CASE_DISMISSED', `Case #${caseId}`, reason, courtCase.title);

      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
      const embed = new EmbedBuilder().setColor(0xfee75c)
        .setTitle(`⚖️ Case #${caseId} Dismissed`)
        .setDescription(`**${courtCase.title}** has been dismissed by an administrator.`)
        .addFields({ name: '📝 Reason', value: reason });

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'close_referendum') {
      const id = interaction.options.getInteger('id');
      const reason = interaction.options.getString('reason');
      const ref = db.prepare('SELECT * FROM referendums WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!ref) return interaction.reply({ embeds: [errorEmbed(`Referendum #${id} not found.`)], flags: 64 });
      if (ref.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Already closed.')], flags: 64 });

      const tally = getReferendumTally(id);
      const result = referendumResult(tally);
      const committed = db.transaction(() => {
        const updated = db.prepare(`UPDATE referendums SET status = 'closed', result = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'active'`)
          .run(result, tally.yes, tally.no, tally.abstain, id);
        if (updated.changes !== 1) return false;
        logAdmin(gid, uid, 'REFERENDUM_FORCE_CLOSED', `Referendum #${id}`, reason, ref.title);
        return true;
      })();
      if (!committed) return interaction.reply({ embeds: [errorEmbed('Already closed.')], flags: 64 });

      return interaction.reply({ embeds: [successEmbed('Referendum Closed',
        `**${ref.title}** has been force-closed.\nResult: **${result.toUpperCase()}** (${tally.yes}Y / ${tally.no}N)\n**Reason:** ${reason}`, gid)] });
    }

    if (sub === 'expire_initiative') {
      const id = interaction.options.getInteger('id');
      const reason = interaction.options.getString('reason');
      const initiative = db.prepare('SELECT * FROM initiatives WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!initiative) return interaction.reply({ embeds: [errorEmbed(`Initiative #${id} not found.`)], flags: 64 });
      if (initiative.status !== 'collecting') return interaction.reply({ embeds: [errorEmbed('Initiative is not currently collecting signatures.')], flags: 64 });

      db.prepare(`UPDATE initiatives SET status = 'expired' WHERE id = ?`).run(id);
      logAdmin(gid, uid, 'INITIATIVE_EXPIRED', `Initiative #${id}`, reason, initiative.title);

      return interaction.reply({ embeds: [successEmbed('Initiative Expired', `**${initiative.title}** has been marked as expired.\n**Reason:** ${reason}`, gid)] });
    }

    if (sub === 'set_reputation') {
      const target = interaction.options.getUser('user');
      const value = interaction.options.getInteger('value');
      const reason = interaction.options.getString('reason');
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed(`${target.username} is not a registered citizen.`)], flags: 64 });

      db.prepare('UPDATE citizens SET reputation = ? WHERE guild_id = ? AND user_id = ?').run(value, gid, target.id);
      logAdmin(gid, uid, 'REPUTATION_SET', target.id, reason, `${citizen.reputation} → ${value}`);

      const sign = value >= 0 ? '+' : '';
      return interaction.reply({ embeds: [successEmbed('Reputation Set',
        `<@${target.id}>'s reputation has been set to **${sign}${value}**.\n**Reason:** ${reason}`, gid)] });
    }

    if (sub === 'announce') {
      const title = interaction.options.getString('title');
      const message = interaction.options.getString('message');
      const colorStr = interaction.options.getString('color') || '#5865F2';
      const pingEveryone = interaction.options.getBoolean('ping_everyone') || false;

      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
      if (!config?.announcement_channel) {
        return interaction.reply({ embeds: [errorEmbed('No announcement channel configured. Use `/setup channels` first.')], flags: 64 });
      }

      const colorInt = parseInt(colorStr.replace('#', ''), 16) || 0x5865f2;
      const embed = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle(`📢 ${title}`)
        .setDescription(message)
        .setFooter({ text: `Announced by ${interaction.user.username} | ${config.government_name}` })
        .setTimestamp();

      const channel = await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null);
      if (!channel) return interaction.reply({ embeds: [errorEmbed('Announcement channel not found.')], flags: 64 });

      await channel.send({ content: pingEveryone ? '@everyone' : null, embeds: [embed] });
      logAdmin(gid, uid, 'ANNOUNCEMENT_SENT', config.announcement_channel, title, message.substring(0, 100));

      return interaction.reply({ content: `✅ Announcement sent in ${channel}!`, flags: 64 });
    }

    if (sub === 'purge_elections') {
      const days = interaction.options.getInteger('days');
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

      const toDelete = db.prepare(`SELECT id FROM elections WHERE guild_id = ? AND status = 'closed' AND ends_at < ?`).all(gid, cutoff);
      if (toDelete.length === 0) return interaction.reply({ embeds: [successEmbed('Nothing to Purge', `No closed elections older than ${days} days found.`, gid)], flags: 64 });

      for (const { id } of toDelete) {
        db.prepare('DELETE FROM votes WHERE election_id = ?').run(id);
        db.prepare('DELETE FROM rcv_votes WHERE election_id = ?').run(id);
        db.prepare('DELETE FROM candidates WHERE election_id = ?').run(id);
        db.prepare('DELETE FROM election_reminders WHERE election_id = ?').run(id);
        db.prepare('DELETE FROM elections WHERE id = ?').run(id);
      }
      logAdmin(gid, uid, 'ELECTIONS_PURGED', `${toDelete.length} elections`, `Older than ${days} days`);
      return interaction.reply({ embeds: [successEmbed('Elections Purged', `${toDelete.length} old closed election(s) have been deleted.`, gid)], flags: 64 });
    }

    if (sub === 'server_stats') {
      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
      const treasury = db.prepare('SELECT * FROM treasury WHERE guild_id = ?').get(gid);

      // Single aggregated query — replaces 14 separate COUNT statements
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM citizens             WHERE guild_id = @g)                          AS citizens,
          (SELECT COUNT(*) FROM parties              WHERE guild_id = @g AND is_active = 1)        AS parties,
          (SELECT COUNT(*) FROM elections            WHERE guild_id = @g)                          AS elections_total,
          (SELECT COUNT(*) FROM elections            WHERE guild_id = @g AND status = 'active')    AS elections_active,
          (SELECT COUNT(*) FROM bills                WHERE guild_id = @g)                          AS bills,
          (SELECT COUNT(*) FROM laws                 WHERE guild_id = @g AND is_active = 1)        AS laws,
          (SELECT COUNT(*) FROM cases                WHERE guild_id = @g AND status != 'closed')   AS cases_open,
          (SELECT COUNT(*) FROM cases                WHERE guild_id = @g)                          AS cases_total,
          (SELECT COUNT(*) FROM referendums          WHERE guild_id = @g)                          AS referendums,
          (SELECT COUNT(*) FROM initiatives          WHERE guild_id = @g)                          AS initiatives,
          (SELECT COUNT(*) FROM impeachments         WHERE guild_id = @g)                          AS impeachments,
          (SELECT COUNT(*) FROM admin_log            WHERE guild_id = @g)                          AS admin_actions,
          (SELECT COUNT(*) FROM activity_log         WHERE guild_id = @g)                          AS activity_entries,
          (SELECT COUNT(*) FROM treasury_transactions WHERE guild_id = @g)                         AS tx_count
      `).get({ g: gid });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔍 Server Stats — ${config?.government_name}`)
        .addFields(
          { name: '👥 Citizens', value: `${counts.citizens}`, inline: true },
          { name: '🏛️ Parties', value: `${counts.parties}`, inline: true },
          { name: '⚖️ Open Cases', value: `${counts.cases_open} / ${counts.cases_total} total`, inline: true },
          { name: '🗳️ Elections', value: `${counts.elections_active} active / ${counts.elections_total} total`, inline: true },
          { name: '📜 Bills / Laws', value: `${counts.bills} bills · ${counts.laws} laws`, inline: true },
          { name: '📊 Referendums', value: `${counts.referendums}`, inline: true },
          { name: '📣 Initiatives', value: `${counts.initiatives}`, inline: true },
          { name: '⚖️ Impeachments', value: `${counts.impeachments}`, inline: true },
          { name: `${treasury?.currency_symbol || '₡'} Treasury`, value: `${treasury?.balance?.toLocaleString() || 0} ${treasury?.currency_name || 'Credits'}`, inline: true },
          { name: '💼 Treasury Transactions', value: `${counts.tx_count}`, inline: true },
          { name: '📋 Admin Actions', value: `${counts.admin_actions}`, inline: true },
          { name: '📡 Activity Log', value: `${counts.activity_entries} entries`, inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }
};
