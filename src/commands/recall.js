import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity, statusField } from '../utils/embeds.js';

const RECALL_EXPIRY_DAYS = 14;

export default {
  data: new SlashCommandBuilder()
    .setName('recall')
    .setDescription('Citizen-driven by-elections to remove an officeholder')
    .addSubcommand(s => s
      .setName('file')
      .setDescription('File a recall petition against a current officeholder')
      .addUserOption(o => o.setName('official').setDescription('The officeholder to recall').setRequired(true))
      .addStringOption(o => o.setName('office').setDescription('The office they hold').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the recall').setRequired(true))
      .addIntegerOption(o => o.setName('signatures').setDescription('Signatures needed (default: server default or 10)').setMinValue(2).setMaxValue(500)))
    .addSubcommand(s => s
      .setName('sign')
      .setDescription('Sign a recall petition')
      .addIntegerOption(o => o.setName('id').setDescription('Recall petition ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View recall petition details')
      .addIntegerOption(o => o.setName('id').setDescription('Recall petition ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all recall petitions'))
    .addSubcommand(s => s
      .setName('trigger')
      .setDescription('Manually trigger a recall election once a petition qualifies (Admin only)')
      .addIntegerOption(o => o.setName('id').setDescription('Recall petition ID').setRequired(true))
      .addIntegerOption(o => o.setName('hours').setDescription('Election duration in hours (default: 48)').setMinValue(1).setMaxValue(720)))
    .addSubcommand(s => s
      .setName('withdraw')
      .setDescription('Withdraw a recall petition (creator or Admin)')
      .addIntegerOption(o => o.setName('id').setDescription('Recall petition ID').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    if (sub === 'file') {
      // Must be a registered citizen
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed('You must be a registered citizen to file a recall petition. Use `/citizen register` first.')], flags: 64 });

      const official = interaction.options.getUser('official');
      const office = interaction.options.getString('office');
      const reason = interaction.options.getString('reason');

      // Verify they actually hold that office
      const officeRecord = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND holder_id = ?').get(gid, office, official.id);
      if (!officeRecord) {
        return interaction.reply({ embeds: [errorEmbed(`<@${official.id}> does not currently hold the office of **${office}**. Check \`/office list\` for current holders.`)], flags: 64 });
      }

      // Can't recall yourself
      if (official.id === uid) return interaction.reply({ embeds: [errorEmbed('You cannot file a recall petition against yourself.')], flags: 64 });

      // Check no active recall already exists for this person/office
      const existing = db.prepare(`SELECT * FROM recalls WHERE guild_id = ? AND target_id = ? AND office = ? AND status IN ('collecting','qualified')`).get(gid, official.id, officeRecord.name);
      if (existing) return interaction.reply({ embeds: [errorEmbed(`There is already an active recall petition against <@${official.id}> for **${officeRecord.name}** (Petition #${existing.id}).`)], flags: 64 });

      const defaultSigs = config?.default_initiative_sigs || 10;
      const signaturesRequired = interaction.options.getInteger('signatures') || defaultSigs;
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + RECALL_EXPIRY_DAYS * 86400;

      const result = db.prepare(`
        INSERT INTO recalls (guild_id, target_id, office, reason, creator_id, signatures_required, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(gid, official.id, officeRecord.name, reason, uid, signaturesRequired, expiresAt);

      // Creator auto-signs
      db.prepare('INSERT INTO recall_signatures (recall_id, signer_id) VALUES (?, ?)').run(result.lastInsertRowid, uid);
      logActivity(gid, 'RECALL_FILED', uid, official.id, `Office: ${officeRecord.name}`);

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('📋 Recall Petition Filed')
        .setDescription(`A recall petition has been filed against <@${official.id}>.`)
        .addFields(
          { name: '🆔 Petition ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '💼 Office', value: officeRecord.name, inline: true },
          { name: '✍️ Signatures Needed', value: `${signaturesRequired}`, inline: true },
          { name: '📝 Reason', value: reason },
          { name: '⏰ Petition Expires', value: `<t:${expiresAt}:F>`, inline: true }
        )
        .setFooter({ text: `Use /recall sign id:${result.lastInsertRowid} to support this petition` })
        .setTimestamp();

      const channel = config?.announcement_channel
        ? await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null)
        : null;

      if (channel && channel.id !== interaction.channelId) {
        await channel.send({ embeds: [embed] });
        return interaction.reply({ content: `✅ Recall petition filed and announced in ${channel}!`, flags: 64 });
      }
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'sign') {
      const id = interaction.options.getInteger('id');
      const recall = db.prepare('SELECT * FROM recalls WHERE id = ? AND guild_id = ?').get(id, gid);

      if (!recall) return interaction.reply({ embeds: [errorEmbed(`Recall petition #${id} not found.`)], flags: 64 });
      if (!['collecting', 'qualified'].includes(recall.status)) {
        return interaction.reply({ embeds: [errorEmbed('This petition is no longer accepting signatures.')], flags: 64 });
      }

      const now = Math.floor(Date.now() / 1000);
      if (recall.expires_at && now > recall.expires_at) {
        db.prepare(`UPDATE recalls SET status = 'failed' WHERE id = ?`).run(id);
        return interaction.reply({ embeds: [errorEmbed('This recall petition has expired.')], flags: 64 });
      }

      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed('You must be a registered citizen to sign a recall petition.')], flags: 64 });

      // Target can't sign their own recall
      if (uid === recall.target_id) return interaction.reply({ embeds: [errorEmbed('You cannot sign a recall petition against yourself.')], flags: 64 });

      try {
        db.prepare('INSERT INTO recall_signatures (recall_id, signer_id) VALUES (?, ?)').run(id, uid);
      } catch (e) {
        return interaction.reply({ embeds: [errorEmbed('You have already signed this recall petition.')], flags: 64 });
      }

      const sigCount = db.prepare('SELECT COUNT(*) as cnt FROM recall_signatures WHERE recall_id = ?').get(id).cnt;
      const remaining = recall.signatures_required - sigCount;

      // Check if threshold reached
      if (sigCount >= recall.signatures_required && recall.status === 'collecting') {
        db.prepare(`UPDATE recalls SET status = 'qualified' WHERE id = ?`).run(id);
        logActivity(gid, 'RECALL_QUALIFIED', uid, `Recall #${id}`, `${sigCount} signatures`);

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('📋 Recall Petition Qualified!')
          .setDescription(`The recall petition against <@${recall.target_id}> for **${recall.office}** has collected enough signatures.\n\nAn administrator must now use \`/recall trigger id:${id}\` to call a recall election.`)
          .addFields(
            { name: '✍️ Signatures', value: `${sigCount} / ${recall.signatures_required}`, inline: true },
            { name: '💼 Office', value: recall.office, inline: true }
          )
          .setFooter({ text: 'Admins: use /recall trigger to call the election' })
          .setTimestamp();

        const channel = config?.announcement_channel
          ? await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null)
          : null;
        if (channel) await channel.send({ embeds: [embed] });
        return interaction.reply({ embeds: [embed] });
      }

      const progressPct = Math.min(100, ((sigCount / recall.signatures_required) * 100)).toFixed(0);
      const filled = Math.round(progressPct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      return interaction.reply({
        embeds: [successEmbed('Petition Signed',
          `You signed the recall petition against <@${recall.target_id}>.\n\n✍️ **${sigCount} / ${recall.signatures_required}** — \`${bar}\` ${progressPct}%\n**${remaining}** more signatures needed.`,
          gid)],
        flags: 64
      });
    }

    if (sub === 'info') {
      const id = interaction.options.getInteger('id');
      const recall = db.prepare('SELECT * FROM recalls WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!recall) return interaction.reply({ embeds: [errorEmbed(`Recall petition #${id} not found.`)], flags: 64 });

      const sigCount = db.prepare('SELECT COUNT(*) as cnt FROM recall_signatures WHERE recall_id = ?').get(id).cnt;
      const pct = Math.min(100, ((sigCount / recall.signatures_required) * 100)).toFixed(0);
      const filled = Math.round(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      const statusColors = { collecting: 0xfee75c, qualified: 0x5865f2, election_called: 0x57f287, completed: 0x57f287, failed: 0xed4245, withdrawn: 0x808080 };

      const embed = new EmbedBuilder()
        .setColor(statusColors[recall.status] || 0x2f3136)
        .setTitle(`📋 Recall Petition #${id}`)
        .addFields(
          { name: '🎯 Target', value: `<@${recall.target_id}>`, inline: true },
          { name: '💼 Office', value: recall.office, inline: true },
          statusField(recall.status, recall.status === 'collecting' ? 'Signatures are open' : recall.status === 'qualified' ? 'Ready for an administrator to trigger' : 'Petition finalized'),
          { name: '👤 Filed By', value: `<@${recall.creator_id}>`, inline: true },
          { name: '📅 Filed', value: `<t:${recall.created_at}:D>`, inline: true },
          { name: '⏰ Expires', value: `<t:${recall.expires_at}:F>`, inline: true },
          { name: '📝 Reason', value: recall.reason },
          { name: '✍️ Signatures', value: `${sigCount} / ${recall.signatures_required}\n\`${bar}\` ${pct}%` }
        );

      if (recall.election_id) embed.addFields({ name: '🗳️ Recall Election', value: `Election #${recall.election_id}`, inline: true });

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const recalls = db.prepare(`
        SELECT r.*, COUNT(s.signer_id) as sig_count
        FROM recalls r
        LEFT JOIN recall_signatures s ON r.id = s.recall_id
        WHERE r.guild_id = ?
        GROUP BY r.id
        ORDER BY r.id DESC LIMIT 15
      `).all(gid);

      if (recalls.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Recall Petitions').setDescription('No recall petitions on record.')] });

      const statusEmoji = { collecting: '✍️', qualified: '✅', election_called: '🗳️', completed: '🏁', failed: '❌', withdrawn: '🚫' };
      const list = recalls.map(r =>
        `${statusEmoji[r.status] || '⚪'} **#${r.id}** — <@${r.target_id}> *(${r.office})* — ${r.sig_count}/${r.signatures_required} sigs`
      ).join('\n');

      return interaction.reply({ embeds: listEmbeds('📋 Recall Petitions', list.split('\n')) });
    }

    if (sub === 'trigger') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });
      }

      const id = interaction.options.getInteger('id');
      const hours = interaction.options.getInteger('hours') || config?.election_duration_hours || 48;
      const recall = db.prepare('SELECT * FROM recalls WHERE id = ? AND guild_id = ?').get(id, gid);

      if (!recall) return interaction.reply({ embeds: [errorEmbed(`Recall petition #${id} not found.`)], flags: 64 });
      if (recall.status !== 'qualified') {
        const msg = recall.status === 'collecting'
          ? 'This petition has not yet collected enough signatures.'
          : `This petition is already in status: **${recall.status}**.`;
        return interaction.reply({ embeds: [errorEmbed(msg)], flags: 64 });
      }

      // Verify officeholder still holds the position
      const officeRecord = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND holder_id = ?').get(gid, recall.office, recall.target_id);
      if (!officeRecord) {
        db.prepare(`UPDATE recalls SET status = 'failed' WHERE id = ?`).run(id);
        return interaction.reply({ embeds: [errorEmbed(`<@${recall.target_id}> no longer holds **${recall.office}**. The recall petition has been marked as failed.`)], flags: 64 });
      }

      const now = Math.floor(Date.now() / 1000);
      const endsAt = now + hours * 3600;

      // Create a recall election in registration so challengers can join before
      // an admin opens voting. ends_at anchors the requested duration; /election
      // open shifts it to the actual opening time.
      const electionTitle = `Recall Election: ${recall.office}`;
      const electionResult = db.prepare(`
        INSERT INTO elections (guild_id, title, office, description, status, voting_type, starts_at, ends_at, created_by)
        VALUES (?, ?, ?, ?, 'registration', 'fptp', NULL, ?, ?)
      `).run(gid, electionTitle, recall.office, `Recall election triggered by Petition #${id}. Should <@${recall.target_id}> be removed from office?`, endsAt, uid);

      // Auto-register the incumbent as a candidate
      db.prepare('INSERT OR IGNORE INTO candidates (election_id, user_id, platform) VALUES (?, ?, ?)').run(
        electionResult.lastInsertRowid, recall.target_id, 'Incumbent — seeking to retain office.'
      );

      db.prepare(`UPDATE recalls SET status = 'election_called', election_id = ? WHERE id = ?`).run(electionResult.lastInsertRowid, id);
      logActivity(gid, 'RECALL_ELECTION_TRIGGERED', uid, recall.target_id, `Petition #${id} → Election #${electionResult.lastInsertRowid}`);

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`🗳️ Recall Election Called: ${recall.office}`)
        .setDescription(`A recall election has been triggered for **${recall.office}**, currently held by <@${recall.target_id}>.\n\nOther candidates may register using \`/election register id:${electionResult.lastInsertRowid}\`. An administrator can open voting with \`/election open id:${electionResult.lastInsertRowid}\` after registration.`)
        .addFields(
          { name: '🆔 Election ID', value: `#${electionResult.lastInsertRowid}`, inline: true },
          { name: '📋 Recall Petition', value: `#${id}`, inline: true },
          { name: '⏰ Voting Window', value: `${hours} hour(s) after voting is opened`, inline: false },
          { name: '📝 Original Reason', value: recall.reason }
        )
        .setTimestamp();

      const channel = config?.election_channel
        ? await interaction.guild.channels.fetch(config.election_channel).catch(() => null)
        : null;

      if (channel) await channel.send({ embeds: [embed] });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'withdraw') {
      const id = interaction.options.getInteger('id');
      const recall = db.prepare('SELECT * FROM recalls WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!recall) return interaction.reply({ embeds: [errorEmbed(`Recall petition #${id} not found.`)], flags: 64 });

      const isCreator = recall.creator_id === uid;
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
      if (!isCreator && !isAdmin) return interaction.reply({ embeds: [errorEmbed('Only the petition creator or an admin can withdraw this.')], flags: 64 });
      if (!['collecting', 'qualified'].includes(recall.status)) return interaction.reply({ embeds: [errorEmbed('This petition cannot be withdrawn in its current state.')], flags: 64 });

      db.prepare(`UPDATE recalls SET status = 'withdrawn' WHERE id = ?`).run(id);
      logActivity(gid, 'RECALL_WITHDRAWN', uid, `Recall #${id}`, recall.office);
      return interaction.reply({ embeds: [successEmbed('Petition Withdrawn', `Recall petition **#${id}** against <@${recall.target_id}> has been withdrawn.`, gid)] });
    }
  }
};
