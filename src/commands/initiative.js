import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, logActivity, statusField } from '../utils/embeds.js';

const DEFAULT_SIGNATURES = 10;
const EXPIRY_DAYS = 14;

export default {
  data: new SlashCommandBuilder()
    .setName('initiative')
    .setDescription('Propose and sign citizen initiatives to force government action')
    .addSubcommand(s => s
      .setName('propose')
      .setDescription('Propose a new citizen initiative')
      .addStringOption(o => o.setName('title').setDescription('Initiative title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('What this initiative is about').setRequired(true))
      .addStringOption(o => o.setName('action').setDescription('What you are demanding the government do').setRequired(true))
      .addStringOption(o => o.setName('type').setDescription('Type of action demanded').setRequired(true)
        .addChoices(
          { name: 'Pass a Bill', value: 'bill' },
          { name: 'Hold a Referendum', value: 'referendum' },
          { name: 'Repeal a Law', value: 'repeal' },
          { name: 'General Demand', value: 'general' }
        ))
      .addIntegerOption(o => o.setName('signatures').setDescription(`Signatures needed (default: ${DEFAULT_SIGNATURES})`).setMinValue(1).setMaxValue(500)))
    .addSubcommand(s => s
      .setName('sign')
      .setDescription('Sign a citizen initiative')
      .addIntegerOption(o => o.setName('id').setDescription('Initiative ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View initiative details')
      .addIntegerOption(o => o.setName('id').setDescription('Initiative ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all active initiatives'))
    .addSubcommand(s => s
      .setName('withdraw')
      .setDescription('Withdraw your initiative (creator only)')
      .addIntegerOption(o => o.setName('id').setDescription('Initiative ID').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'propose') {
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed('You must be a registered citizen to propose an initiative. Use `/citizen register` first.')], flags: 64 });

      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
      const serverDefault = config?.default_initiative_sigs || DEFAULT_SIGNATURES;

      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const action = interaction.options.getString('action');
      const type = interaction.options.getString('type');
      const signaturesRequired = interaction.options.getInteger('signatures') || serverDefault;

      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + EXPIRY_DAYS * 86400;

      const result = db.prepare(`
        INSERT INTO initiatives (guild_id, title, description, proposed_action, type, creator_id, signatures_required, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(gid, title, description, action, type, uid, signaturesRequired, expiresAt);

      // Creator auto-signs
      db.prepare('INSERT INTO initiative_signatures (initiative_id, signer_id) VALUES (?, ?)').run(result.lastInsertRowid, uid);
      logActivity(gid, 'INITIATIVE_PROPOSED', uid, title, type);

      const typeLabel = { bill: '📋 Pass a Bill', referendum: '🗳️ Hold a Referendum', repeal: '🗑️ Repeal a Law', general: '📢 General Demand' };

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📣 Citizen Initiative Filed!')
        .setDescription(`**${title}**\n\n${description}`)
        .addFields(
          { name: '🆔 Initiative ID', value: `#${result.lastInsertRowid}`, inline: true },
          { name: '📋 Type', value: typeLabel[type] || type, inline: true },
          { name: '✍️ Signatures Needed', value: `${signaturesRequired}`, inline: true },
          { name: '📢 Demanded Action', value: action },
          { name: '⏰ Expires', value: `<t:${expiresAt}:F>`, inline: false }
        )
        .setFooter({ text: `Use /initiative sign id:${result.lastInsertRowid} to support this initiative!` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'sign') {
      const id = interaction.options.getInteger('id');
      const initiative = db.prepare('SELECT * FROM initiatives WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!initiative) return interaction.reply({ embeds: [errorEmbed(`Initiative #${id} not found.`)], flags: 64 });
      if (initiative.status !== 'collecting') return interaction.reply({ embeds: [errorEmbed('This initiative is no longer collecting signatures.')], flags: 64 });

      const now = Math.floor(Date.now() / 1000);
      if (initiative.expires_at && now > initiative.expires_at) {
        db.prepare(`UPDATE initiatives SET status = 'expired' WHERE id = ?`).run(id);
        return interaction.reply({ embeds: [errorEmbed('This initiative has expired.')], flags: 64 });
      }

      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!citizen) return interaction.reply({ embeds: [errorEmbed('You must be a registered citizen to sign an initiative.')], flags: 64 });

      try {
        db.prepare('INSERT INTO initiative_signatures (initiative_id, signer_id) VALUES (?, ?)').run(id, uid);
      } catch (e) {
        return interaction.reply({ embeds: [errorEmbed('You have already signed this initiative.')], flags: 64 });
      }

      const signatureCount = db.prepare('SELECT COUNT(*) as cnt FROM initiative_signatures WHERE initiative_id = ?').get(id).cnt;
      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

      // Check if threshold reached
      if (signatureCount >= initiative.signatures_required) {
        db.prepare(`UPDATE initiatives SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?`).run(now, id);
        logActivity(gid, 'INITIATIVE_FULFILLED', uid, initiative.title, `${signatureCount} signatures`);

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🎉 Initiative Threshold Reached!')
          .setDescription(`**${initiative.title}** has collected enough signatures!\n\n📢 **Demanded Action:** ${initiative.proposed_action}`)
          .addFields(
            { name: '✍️ Signatures Collected', value: `${signatureCount} / ${initiative.signatures_required}`, inline: true },
            { name: '👤 Filed By', value: `<@${initiative.creator_id}>`, inline: true }
          )
          .setFooter({ text: 'Government leaders must now respond to this initiative.' })
          .setTimestamp();

        const channel = config?.announcement_channel
          ? await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null)
          : null;

        if (channel) await channel.send({ embeds: [embed] });
        return interaction.reply({ embeds: [embed] });
      }

      const remaining = initiative.signatures_required - signatureCount;
      return interaction.reply({
        embeds: [successEmbed('Initiative Signed',
          `You signed **${initiative.title}**.\n\n✍️ **${signatureCount} / ${initiative.signatures_required}** signatures collected — **${remaining}** more needed.`,
          gid
        )],
        flags: 64
      });
    }

    if (sub === 'info') {
      const id = interaction.options.getInteger('id');
      const initiative = db.prepare('SELECT * FROM initiatives WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!initiative) return interaction.reply({ embeds: [errorEmbed(`Initiative #${id} not found.`)], flags: 64 });

      const signatureCount = db.prepare('SELECT COUNT(*) as cnt FROM initiative_signatures WHERE initiative_id = ?').get(id).cnt;
      const pct = Math.min(100, ((signatureCount / initiative.signatures_required) * 100)).toFixed(0);

      const progressBar = (() => {
        const filled = Math.round(pct / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
      })();

      const statusColors = { collecting: 0x5865f2, fulfilled: 0x57f287, expired: 0xed4245, withdrawn: 0x808080 };
      const typeLabel = { bill: '📋 Pass a Bill', referendum: '🗳️ Hold a Referendum', repeal: '🗑️ Repeal a Law', general: '📢 General Demand' };

      const embed = new EmbedBuilder()
        .setColor(statusColors[initiative.status] || 0x2f3136)
        .setTitle(`📣 Initiative #${id}: ${initiative.title}`)
        .setDescription(initiative.description)
        .addFields(
          { name: '📋 Type', value: typeLabel[initiative.type] || initiative.type, inline: true },
          statusField(initiative.status, initiative.status === 'collecting' ? 'Signatures are open' : 'No longer accepting signatures'),
          { name: '👤 Filed By', value: `<@${initiative.creator_id}>`, inline: true },
          { name: '📢 Demanded Action', value: initiative.proposed_action },
          { name: '✍️ Signatures', value: `${signatureCount} / ${initiative.signatures_required}\n\`${progressBar}\`` },
          { name: '⏰ Expires', value: `<t:${initiative.expires_at}:F>`, inline: true }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      // FIX: single query with signature counts (no N+1)
      const initiatives = db.prepare(`
        SELECT i.*, COUNT(s.signer_id) as sig_count
        FROM initiatives i
        LEFT JOIN initiative_signatures s ON i.id = s.initiative_id
        WHERE i.guild_id = ?
        GROUP BY i.id
        ORDER BY i.id DESC LIMIT 15
      `).all(gid);

      if (initiatives.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📣 Citizen Initiatives').setDescription('No initiatives have been filed yet.')] });

      const statusEmoji = { collecting: '✍️', fulfilled: '✅', expired: '🔴', withdrawn: '🚫' };
      const list = initiatives.map(i =>
        `${statusEmoji[i.status] || '⚪'} **#${i.id}** — ${i.title} *(${i.sig_count}/${i.signatures_required} signatures)*`
      ).join('\n');

      return interaction.reply({ embeds: listEmbeds('📣 Citizen Initiatives', list.split('\n')) });
    }

    if (sub === 'withdraw') {
      const id = interaction.options.getInteger('id');
      const initiative = db.prepare('SELECT * FROM initiatives WHERE id = ? AND guild_id = ?').get(id, gid);
      if (!initiative) return interaction.reply({ embeds: [errorEmbed(`Initiative #${id} not found.`)], flags: 64 });
      if (initiative.creator_id !== uid && !interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ embeds: [errorEmbed('Only the initiative creator or an admin can withdraw this.')], flags: 64 });
      }
      if (initiative.status !== 'collecting') return interaction.reply({ embeds: [errorEmbed('This initiative cannot be withdrawn in its current state.')], flags: 64 });

      db.prepare(`UPDATE initiatives SET status = 'withdrawn' WHERE id = ?`).run(id);
      logActivity(gid, 'INITIATIVE_WITHDRAWN', uid, initiative.title, '');
      return interaction.reply({ embeds: [successEmbed('Initiative Withdrawn', `**${initiative.title}** has been withdrawn.`, gid)] });
    }
  }
};
