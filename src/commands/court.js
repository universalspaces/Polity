import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity, requireCitizen } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('court')
    .setDescription('Manage the judicial system')
    .addSubcommand(s => s
      .setName('file')
      .setDescription('File a court case')
      .addStringOption(o => o.setName('title').setDescription('Case title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Full description of the case').setRequired(true))
      .addUserOption(o => o.setName('defendant').setDescription('The defendant (if any)')))
    .addSubcommand(s => s
      .setName('assign')
      .setDescription('Assign a judge to a case (Admin or appointed judge)')
      .addIntegerOption(o => o.setName('case_id').setDescription('Case ID').setRequired(true))
      .addUserOption(o => o.setName('judge').setDescription('The judge to assign — must be an appointed judge').setRequired(true)))
    .addSubcommand(s => s
      .setName('rule')
      .setDescription('Issue a ruling on a case (assigned judge only)')
      .addIntegerOption(o => o.setName('case_id').setDescription('Case ID').setRequired(true))
      .addStringOption(o => o.setName('verdict').setDescription('Verdict').setRequired(true)
        .addChoices(
          { name: 'Guilty / In Favor of Plaintiff', value: 'guilty' },
          { name: 'Not Guilty / In Favor of Defendant', value: 'not_guilty' },
          { name: 'Dismissed', value: 'dismissed' },
          { name: 'Settled', value: 'settled' }
        ))
      .addStringOption(o => o.setName('ruling').setDescription('Full ruling/opinion text').setRequired(true)))
    .addSubcommand(s => s
      .setName('appeal')
      .setDescription('Appeal a closed case')
      .addIntegerOption(o => o.setName('case_id').setDescription('Original case ID').setRequired(true))
      .addStringOption(o => o.setName('grounds').setDescription('Grounds for appeal').setRequired(true)))
    .addSubcommand(s => s
      .setName('assign_appeal')
      .setDescription('Assign a judge to an appeal (Admin or appointed judge)')
      .addIntegerOption(o => o.setName('appeal_id').setDescription('Appeal ID').setRequired(true))
      .addUserOption(o => o.setName('judge').setDescription('The judge to assign — must be an appointed judge').setRequired(true)))
    .addSubcommand(s => s
      .setName('rule_appeal')
      .setDescription('Issue a ruling on an appeal (assigned judge only)')
      .addIntegerOption(o => o.setName('appeal_id').setDescription('Appeal ID').setRequired(true))
      .addStringOption(o => o.setName('verdict').setDescription('Verdict').setRequired(true)
        .addChoices(
          { name: 'Appeal Upheld — Original verdict overturned', value: 'upheld' },
          { name: 'Appeal Dismissed — Original verdict stands', value: 'dismissed' }
        ))
      .addStringOption(o => o.setName('ruling').setDescription('Ruling text').setRequired(true)))
    .addSubcommand(s => s
      .setName('appoint_judge')
      .setDescription('Appoint a citizen as a judge (Admin only)')
      .addUserOption(o => o.setName('user').setDescription('Citizen to appoint').setRequired(true)))
    .addSubcommand(s => s
      .setName('remove_judge')
      .setDescription('Remove a judge (Admin only)')
      .addUserOption(o => o.setName('user').setDescription('Judge to remove').setRequired(true)))
    .addSubcommand(s => s
      .setName('judges')
      .setDescription('List all appointed judges'))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View case details')
      .addIntegerOption(o => o.setName('case_id').setDescription('Case ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all court cases')
      .addStringOption(o => o.setName('status').setDescription('Filter by status')
        .addChoices(
          { name: 'Filed', value: 'filed' },
          { name: 'In Progress', value: 'in_progress' },
          { name: 'Closed', value: 'closed' },
          { name: 'All', value: 'all' }
        ))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const isJudge = (userId) => !!db.prepare('SELECT 1 FROM judges WHERE guild_id = ? AND user_id = ? AND is_active = 1').get(gid, userId);

    if (sub === 'appoint_judge') {
      if (!isAdmin) return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      const target = interaction.options.getUser('user');
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed(`${target.username} must be a registered citizen to be appointed as a judge.`)], flags: 64 });
      if (isJudge(target.id)) return interaction.reply({ embeds: [errorEmbed(`${target.username} is already an appointed judge.`)], flags: 64 });

      db.prepare('INSERT OR REPLACE INTO judges (guild_id, user_id, appointed_by, is_active) VALUES (?, ?, ?, 1)').run(gid, target.id, uid);
      logActivity(gid, 'JUDGE_APPOINTED', uid, target.id, '');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('👨‍⚖️ Judge Appointed')
        .setDescription(`<@${target.id}> has been appointed as a judge of **${config?.government_name || 'the Republic'}**.`);

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'remove_judge') {
      if (!isAdmin) return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      const target = interaction.options.getUser('user');
      if (!isJudge(target.id)) return interaction.reply({ embeds: [errorEmbed(`${target.username} is not an appointed judge.`)], flags: 64 });
      db.prepare('UPDATE judges SET is_active = 0 WHERE guild_id = ? AND user_id = ?').run(gid, target.id);
      logActivity(gid, 'JUDGE_REMOVED', uid, target.id, '');
      return interaction.reply({ embeds: [successEmbed('Judge Removed', `<@${target.id}> has been removed from the judiciary.`, gid)] });
    }

    if (sub === 'judges') {
      const judges = db.prepare('SELECT * FROM judges WHERE guild_id = ? AND is_active = 1 ORDER BY appointed_at ASC').all(gid);
      if (judges.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('👨‍⚖️ Judiciary').setDescription('No judges have been appointed yet. Use `/court appoint_judge` to appoint one.')] });
      const list = judges.map(j => `👨‍⚖️ <@${j.user_id}> — appointed <t:${j.appointed_at}:D>`).join('\n');
      return interaction.reply({ embeds: listEmbeds('👨‍⚖️ Appointed Judges', list.split('\n')) });
    }

    if (sub === 'file') {
      if (config?.require_citizenship) {
        if (!await requireCitizen(interaction)) return;
      }
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const defendant = interaction.options.getUser('defendant');

      const result = db.prepare(`INSERT INTO cases (guild_id, title, description, plaintiff_id, defendant_id, status) VALUES (?, ?, ?, ?, ?, 'filed')`)
        .run(gid, title, description, uid, defendant?.id || null);
      logActivity(gid, 'CASE_FILED', uid, title, `Defendant: ${defendant?.id || 'None'}`);

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⚖️ Case Filed: ${title}`)
        .setDescription(description)
        .addFields(
          { name: '🆔 Case ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '👤 Plaintiff', value: `<@${uid}>`, inline: true },
          { name: '🎯 Defendant', value: defendant ? `<@${defendant.id}>` : 'N/A', inline: true },
          { name: '📋 Status', value: 'FILED — Awaiting judge assignment', inline: false }
        )
        .setTimestamp();

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed], flags: config?.court_channel ? 64 : undefined });
    }

    if (sub === 'assign') {
      if (!isAdmin && !isJudge(uid)) {
        return interaction.reply({ embeds: [errorEmbed('Only admins or appointed judges can assign judges to cases.')], flags: 64 });
      }
      const caseId = interaction.options.getInteger('case_id');
      const judgeUser = interaction.options.getUser('judge');

      if (!isJudge(judgeUser.id)) {
        return interaction.reply({ embeds: [errorEmbed(`<@${judgeUser.id}> is not an appointed judge. Use \`/court appoint_judge\` first.`)], flags: 64 });
      }

      const courtCase = db.prepare('SELECT * FROM cases WHERE id = ? AND guild_id = ?').get(caseId, gid);
      if (!courtCase) return interaction.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)], flags: 64 });
      if (courtCase.status === 'closed') return interaction.reply({ embeds: [errorEmbed('This case is already closed.')], flags: 64 });

      db.prepare(`UPDATE cases SET judge_id = ?, status = 'in_progress' WHERE id = ?`).run(judgeUser.id, caseId);
      logActivity(gid, 'JUDGE_ASSIGNED', uid, `Case #${caseId}`, judgeUser.id);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`⚖️ Judge Assigned — Case #${caseId}`)
        .setDescription(`**${courtCase.title}** has been assigned to <@${judgeUser.id}>.`)
        .addFields({ name: '👨‍⚖️ Judge', value: `<@${judgeUser.id}>`, inline: true });

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ content: `<@${judgeUser.id}>`, embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'rule') {
      const caseId = interaction.options.getInteger('case_id');
      const verdict = interaction.options.getString('verdict');
      const ruling = interaction.options.getString('ruling');
      const courtCase = db.prepare('SELECT * FROM cases WHERE id = ? AND guild_id = ?').get(caseId, gid);

      if (!courtCase) return interaction.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)], flags: 64 });
      if (courtCase.status === 'closed') return interaction.reply({ embeds: [errorEmbed('This case is already closed.')], flags: 64 });
      if (courtCase.judge_id !== uid && !isAdmin) {
        return interaction.reply({ embeds: [errorEmbed('Only the assigned judge can issue a ruling.')], flags: 64 });
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`UPDATE cases SET status = 'closed', verdict = ?, ruling = ?, ruled_at = ? WHERE id = ?`).run(verdict, ruling, now, caseId);
      logActivity(gid, 'CASE_RULED', uid, `Case #${caseId}`, verdict);

      const verdictLabel = { guilty: '✅ Guilty / In Favor of Plaintiff', not_guilty: '❌ Not Guilty / In Favor of Defendant', dismissed: '🚫 Dismissed', settled: '🤝 Settled' };
      const verdictColor = { guilty: 0xed4245, not_guilty: 0x57f287, dismissed: 0xfee75c, settled: 0x5865f2 };

      const embed = new EmbedBuilder()
        .setColor(verdictColor[verdict] || 0x2f3136)
        .setTitle(`⚖️ Ruling Issued — Case #${caseId}: ${courtCase.title}`)
        .addFields(
          { name: '⚖️ Verdict', value: verdictLabel[verdict], inline: false },
          { name: '📜 Ruling', value: ruling },
          { name: '👨‍⚖️ Judge', value: `<@${uid}>`, inline: true },
          { name: '📅 Date', value: `<t:${now}:F>`, inline: true },
          { name: '💡 Appeals', value: 'Parties may appeal with `/court appeal`', inline: false }
        )
        .setTimestamp();

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'appeal') {
      if (config?.require_citizenship) {
        if (!await requireCitizen(interaction)) return;
      }
      const caseId = interaction.options.getInteger('case_id');
      const grounds = interaction.options.getString('grounds');
      const courtCase = db.prepare('SELECT * FROM cases WHERE id = ? AND guild_id = ?').get(caseId, gid);

      if (!courtCase) return interaction.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)], flags: 64 });
      if (courtCase.status !== 'closed') return interaction.reply({ embeds: [errorEmbed('You can only appeal a closed case.')], flags: 64 });

      if (uid !== courtCase.plaintiff_id && uid !== courtCase.defendant_id && !isAdmin) {
        return interaction.reply({ embeds: [errorEmbed('Only the plaintiff or defendant in this case can file an appeal.')], flags: 64 });
      }

      const existingAppeal = db.prepare(`SELECT * FROM case_appeals WHERE original_case_id = ? AND status != 'closed'`).get(caseId);
      if (existingAppeal) return interaction.reply({ embeds: [errorEmbed(`An appeal is already in progress for Case #${caseId} (Appeal #${existingAppeal.id}).`)], flags: 64 });

      const result = db.prepare(`
        INSERT INTO case_appeals (guild_id, original_case_id, title, grounds, appellant_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(gid, caseId, `Appeal of Case #${caseId}: ${courtCase.title}`, grounds, uid);

      logActivity(gid, 'CASE_APPEALED', uid, `Case #${caseId}`, grounds);

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⚖️ Appeal Filed — Case #${caseId}`)
        .setDescription(`<@${uid}> has appealed the ruling in **${courtCase.title}**.`)
        .addFields(
          { name: '🆔 Appeal ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '📝 Grounds', value: grounds },
          { name: '📋 Status', value: 'Filed — Awaiting judge assignment', inline: false }
        )
        .setTimestamp();

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }


    if (sub === 'assign_appeal') {
      if (!isAdmin && !isJudge(uid)) {
        return interaction.reply({ embeds: [errorEmbed('Only admins or appointed judges can assign judges to appeals.')], flags: 64 });
      }

      const appealId = interaction.options.getInteger('appeal_id');
      const judgeUser = interaction.options.getUser('judge');

      if (!isJudge(judgeUser.id)) {
        return interaction.reply({ embeds: [errorEmbed(`<@${judgeUser.id}> is not an appointed judge. Use \`/court appoint_judge\` first.`)], flags: 64 });
      }

      const appeal = db.prepare('SELECT * FROM case_appeals WHERE id = ? AND guild_id = ?').get(appealId, gid);
      if (!appeal) return interaction.reply({ embeds: [errorEmbed(`Appeal #${appealId} not found.`)], flags: 64 });
      if (appeal.status === 'closed') return interaction.reply({ embeds: [errorEmbed('This appeal is already closed.')], flags: 64 });

      const origCase = db.prepare('SELECT * FROM cases WHERE id = ?').get(appeal.original_case_id);
      if (origCase?.judge_id === judgeUser.id) {
        return interaction.reply({ embeds: [errorEmbed('The judge who ruled on the original case cannot be assigned to its appeal.')], flags: 64 });
      }

      db.prepare(`UPDATE case_appeals SET judge_id = ?, status = 'in_progress' WHERE id = ?`).run(judgeUser.id, appealId);
      logActivity(gid, 'APPEAL_JUDGE_ASSIGNED', uid, `Appeal #${appealId}`, judgeUser.id);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`⚖️ Judge Assigned — Appeal #${appealId}`)
        .setDescription(`**${appeal.title}** has been assigned to <@${judgeUser.id}>.`)
        .addFields({ name: '👨‍⚖️ Judge', value: `<@${judgeUser.id}>`, inline: true });

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ content: `<@${judgeUser.id}>`, embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'rule_appeal') {
      const appealId = interaction.options.getInteger('appeal_id');
      const verdict = interaction.options.getString('verdict');
      const ruling = interaction.options.getString('ruling');
      const appeal = db.prepare('SELECT * FROM case_appeals WHERE id = ? AND guild_id = ?').get(appealId, gid);

      if (!appeal) return interaction.reply({ embeds: [errorEmbed(`Appeal #${appealId} not found.`)], flags: 64 });
      if (appeal.status === 'closed') return interaction.reply({ embeds: [errorEmbed('This appeal has already been ruled on.')], flags: 64 });
      if (appeal.judge_id !== uid && !isAdmin) {
        return interaction.reply({ embeds: [errorEmbed('Only the assigned judge can rule on this appeal.')], flags: 64 });
      }
      // Original case judge cannot rule on its own appeal
      const origCase = db.prepare('SELECT * FROM cases WHERE id = ?').get(appeal.original_case_id);
      if (origCase?.judge_id === uid && !isAdmin) {
        return interaction.reply({ embeds: [errorEmbed('The judge who ruled on the original case cannot rule on its appeal.')], flags: 64 });
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`UPDATE case_appeals SET status = 'closed', verdict = ?, ruling = ?, ruled_at = ? WHERE id = ?`).run(verdict, ruling, now, appealId);
      logActivity(gid, 'APPEAL_RULED', uid, `Appeal #${appealId}`, verdict);

      const verdictColor = { upheld: 0x57f287, dismissed: 0xed4245 };
      const verdictLabel = { upheld: '✅ Appeal Upheld — Original verdict overturned', dismissed: '❌ Appeal Dismissed — Original verdict stands' };

      const embed = new EmbedBuilder()
        .setColor(verdictColor[verdict] || 0x2f3136)
        .setTitle(`⚖️ Appeal Ruling — #${appealId}`)
        .setDescription(verdictLabel[verdict])
        .addFields(
          { name: '📜 Ruling', value: ruling },
          { name: '👨‍⚖️ Judge', value: `<@${uid}>`, inline: true },
          { name: '📅 Date', value: `<t:${now}:F>`, inline: true }
        )
        .setTimestamp();

      if (config?.court_channel) {
        const channel = await interaction.guild.channels.fetch(config.court_channel).catch(() => null);
        if (channel) await channel.send({ embeds: [embed] });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'info') {
      const caseId = interaction.options.getInteger('case_id');
      const courtCase = db.prepare('SELECT * FROM cases WHERE id = ? AND guild_id = ?').get(caseId, gid);
      if (!courtCase) return interaction.reply({ embeds: [errorEmbed(`Case #${caseId} not found.`)], flags: 64 });

      const appeal = db.prepare('SELECT * FROM case_appeals WHERE original_case_id = ? ORDER BY id DESC LIMIT 1').get(caseId);
      const statusColors = { filed: 0xfee75c, in_progress: 0x5865f2, closed: 0x57f287 };
      const embed = new EmbedBuilder()
        .setColor(statusColors[courtCase.status] || 0x2f3136)
        .setTitle(`⚖️ Case #${caseId}: ${courtCase.title}`)
        .setDescription(courtCase.description)
        .addFields(
          { name: '📋 Status', value: courtCase.status.toUpperCase().replace('_', ' '), inline: true },
          { name: '👤 Plaintiff', value: `<@${courtCase.plaintiff_id}>`, inline: true },
          { name: '🎯 Defendant', value: courtCase.defendant_id ? `<@${courtCase.defendant_id}>` : 'N/A', inline: true },
          { name: '👨‍⚖️ Judge', value: courtCase.judge_id ? `<@${courtCase.judge_id}>${isJudge(courtCase.judge_id) ? ' *(Appointed)*' : ''}` : 'Not assigned', inline: true },
          { name: '📅 Filed', value: `<t:${courtCase.filed_at}:D>`, inline: true }
        );

      if (courtCase.verdict) {
        embed.addFields(
          { name: '⚖️ Verdict', value: courtCase.verdict.replace('_', ' ').toUpperCase(), inline: true },
          { name: '📜 Ruling', value: courtCase.ruling || 'N/A' }
        );
      }
      if (appeal) {
        embed.addFields({ name: '📋 Appeal', value: `Appeal #${appeal.id} — **${appeal.status.toUpperCase()}**${appeal.verdict ? ` (${appeal.verdict})` : ''}`, inline: false });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const status = interaction.options.getString('status') || 'all';
      const query = status === 'all'
        ? db.prepare('SELECT * FROM cases WHERE guild_id = ? ORDER BY id DESC LIMIT 15').all(gid)
        : db.prepare('SELECT * FROM cases WHERE guild_id = ? AND status = ? ORDER BY id DESC LIMIT 15').all(gid, status);

      if (query.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚖️ Court Cases').setDescription('No cases found.')] });

      const statusEmoji = { filed: '🟡', in_progress: '🔵', closed: '🟢' };
      const list = query.map(c => `${statusEmoji[c.status] || '⚪'} **#${c.id}** — ${c.title} *(${c.status.replace('_', ' ')})*`).join('\n');
      return interaction.reply({ embeds: listEmbeds('⚖️ Court Docket', list.split('\n')) });
    }
  }
};
