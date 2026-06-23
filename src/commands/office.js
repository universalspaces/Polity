import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, logActivity } from '../utils/embeds.js';

// ── Prepared statements ──────────────────────────────────────────────────────
const stmtGetOffice    = db.prepare('SELECT * FROM offices WHERE guild_id = ? AND LOWER(name) = LOWER(?)');
const stmtAllOffices   = db.prepare('SELECT * FROM offices WHERE guild_id = ? ORDER BY name ASC');
const stmtInsertOffice = db.prepare(
  'INSERT INTO offices (guild_id, name, description, role_id, term_length_days, is_elected, is_permanent) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const stmtDeleteOffice = db.prepare('DELETE FROM offices WHERE id = ?');
const stmtSetHolder    = db.prepare('UPDATE offices SET holder_id = ?, assumed_at = ? WHERE id = ?');
const stmtClearHolder  = db.prepare('UPDATE offices SET holder_id = NULL, assumed_at = NULL WHERE id = ?');
const stmtInsertHistory = db.prepare(
  'INSERT INTO office_history (guild_id, office_name, user_id, assumed_at, vacated_at, reason) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtTermLimit    = db.prepare('SELECT * FROM term_limits WHERE guild_id = ? AND LOWER(office_name) = LOWER(?)');
const stmtTermCount    = db.prepare(
  'SELECT COUNT(*) as cnt FROM office_history WHERE guild_id = ? AND office_name = ? AND user_id = ?'
);

// ── Helpers ──────────────────────────────────────────────────────────────────
function termLabel(office) {
  return office.is_permanent ? '♾️ Permanent' : `${office.term_length_days}d term`;
}

function typeBadge(office) {
  if (office.is_permanent) return '📌 Permanent';
  return office.is_elected ? '🗳️ Elected' : '👑 Appointed';
}

async function addRole(guild, userId, roleId) {
  if (!roleId) return null;
  try { await (await guild.members.fetch(userId)).roles.add(roleId); return null; }
  catch (error) { console.warn(`[ROLE SYNC] Failed to add role ${roleId} to ${userId}:`, error); return error; }
}

async function removeRole(guild, userId, roleId) {
  if (!roleId) return null;
  try { await (await guild.members.fetch(userId)).roles.remove(roleId); return null; }
  catch (error) { console.warn(`[ROLE SYNC] Failed to remove role ${roleId} from ${userId}:`, error); return error; }
}

// ────────────────────────────────────────────────────────────────────────────

export default {
  data: new SlashCommandBuilder()
    .setName('office')
    .setDescription('Manage government offices and positions')

    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a government office (Admin only)')
      .addStringOption(o => o.setName('name').setDescription('Office name').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Office description'))
      .addRoleOption(o => o.setName('role').setDescription('Discord role for this office'))
      .addBooleanOption(o => o.setName('permanent').setDescription('Permanent office? Holders are appointed/removed — no term clock'))
      .addIntegerOption(o => o.setName('term_days').setDescription('Term length in days (ignored for permanent offices)').setMinValue(1).setMaxValue(365))
      .addBooleanOption(o => o.setName('elected').setDescription('Elected office? (ignored for permanent offices)')))

    .addSubcommand(s => s
      .setName('appoint')
      .setDescription('Appoint someone to an office (Admin only)')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true).setAutocomplete(true))
      .addUserOption(o => o.setName('user').setDescription('User to appoint').setRequired(true)))

    .addSubcommand(s => s
      .setName('remove')
      .setDescription('Remove someone from an office (Admin only)')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true).setAutocomplete(true)))

    .addSubcommand(s => s
      .setName('delete')
      .setDescription('Permanently delete a government office (Admin only)')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm deletion').setRequired(true)))

    .addSubcommand(s => s
      .setName('info')
      .setDescription('View details about a specific office')
      .addStringOption(o => o.setName('office').setDescription('Office name').setRequired(true).setAutocomplete(true)))

    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all government offices')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const offices = stmtAllOffices.all(interaction.guildId);
    const choices = offices
      .filter(o => o.name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25)
      .map(o => ({ name: o.name, value: o.name }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    // ── /office create ───────────────────────────────────────────────────
    if (sub === 'create') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }

      const name        = interaction.options.getString('name').trim();
      const description = interaction.options.getString('description') || '';
      const role        = interaction.options.getRole('role');
      const isPermanent = interaction.options.getBoolean('permanent') ?? false;
      const termDays    = isPermanent ? 0 : (interaction.options.getInteger('term_days') || 30);
      const isElected   = isPermanent ? false : (interaction.options.getBoolean('elected') !== false);

      try {
        stmtInsertOffice.run(gid, name, description, role?.id || null, termDays, isElected ? 1 : 0, isPermanent ? 1 : 0);
      } catch {
        return interaction.reply({ embeds: [errorEmbed(`Office **${name}** already exists.`)], flags: 64 });
      }

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🏛️ Office Created')
        .addFields(
          { name: '💼 Name',        value: name,                                  inline: true },
          { name: '📋 Type',        value: typeBadge({ is_permanent: isPermanent, is_elected: isElected }), inline: true },
          { name: '⏱️ Term',        value: isPermanent ? '♾️ Permanent' : `${termDays} days`, inline: true },
          { name: '🎭 Role',        value: role ? `${role}` : 'None',             inline: true },
          { name: '📝 Description', value: description || 'No description.' }
        )
        .setTimestamp();

      logActivity(gid, 'OFFICE_CREATED', uid, name, null);
      return interaction.reply({ embeds: [embed] });
    }

    // ── /office appoint ───────────────────────────────────────────────────
    if (sub === 'appoint') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Manage Server permissions required.')], flags: 64 });
      }

      const officeName = interaction.options.getString('office');
      const target     = interaction.options.getUser('user');
      const office     = stmtGetOffice.get(gid, officeName);
      if (!office) return interaction.reply({ embeds: [errorEmbed(`Office **${officeName}** not found.`)], flags: 64 });

      // Term limit check (permanent offices don't track terms)
      if (!office.is_permanent) {
        const limit = stmtTermLimit.get(gid, office.name);
        if (limit) {
          const termsServed = stmtTermCount.get(gid, office.name, target.id).cnt;
          if (termsServed >= limit.max_terms) {
            return interaction.reply({
              embeds: [errorEmbed(
                `<@${target.id}> has already served the maximum **${limit.max_terms}** term(s) as **${office.name}** and cannot be reappointed.`
              )],
              flags: 64
            });
          }
        }
      }

      // Archive & evict previous holder
      const appointedAt = Math.floor(Date.now() / 1000);
      db.transaction(() => {
        if (office.holder_id && office.assumed_at) {
          stmtInsertHistory.run(gid, office.name, office.holder_id, office.assumed_at, appointedAt, 'replaced');
        }
        stmtSetHolder.run(target.id, appointedAt, office.id);
        logActivity(gid, 'OFFICE_APPOINTED', uid, office.name, target.id);
      })();
      const removeError = office.holder_id ? await removeRole(interaction.guild, office.holder_id, office.role_id) : null;
      const addError = await addRole(interaction.guild, target.id, office.role_id);

      const note = office.is_permanent ? '\n*This is a permanent position — they serve until removed.*' : '';
      const syncNote = removeError || addError ? '\n\n⚠️ The office was updated, but one or more Discord roles could not be synchronized. Check the bot role hierarchy and permissions.' : '';
      return interaction.reply({
        embeds: [successEmbed('Appointment Made', `<@${target.id}> has been appointed as **${office.name}**.${note}${syncNote}`, gid)]
      });
    }

    // ── /office remove ────────────────────────────────────────────────────
    if (sub === 'remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Manage Server permissions required.')], flags: 64 });
      }

      const officeName = interaction.options.getString('office');
      const office     = stmtGetOffice.get(gid, officeName);
      if (!office || !office.holder_id) {
        return interaction.reply({ embeds: [errorEmbed(`Office **${officeName}** not found or is already vacant.`)], flags: 64 });
      }

      const prevHolder = office.holder_id;
      const now        = Math.floor(Date.now() / 1000);

      db.transaction(() => {
        if (office.assumed_at) stmtInsertHistory.run(gid, office.name, prevHolder, office.assumed_at, now, 'removed');
        stmtClearHolder.run(office.id);
        logActivity(gid, 'OFFICE_REMOVED', uid, office.name, prevHolder);
      })();
      const roleError = await removeRole(interaction.guild, prevHolder, office.role_id);

      // Announce vacancy
      const config = db.prepare('SELECT announcement_channel FROM server_config WHERE guild_id = ?').get(gid);
      if (config?.announcement_channel) {
        try {
          const chan = await interaction.guild.channels.fetch(config.announcement_channel).catch(() => null);
          if (chan) {
            await chan.send({
              embeds: [new EmbedBuilder()
                .setColor(0xfee75c)
                .setTitle(`💼 Office Vacant: ${office.name}`)
                .setDescription(`<@${prevHolder}> has been removed from **${office.name}**. This position is now vacant.`)
                .setTimestamp()]
            });
          }
        } catch (error) {
          console.warn(`[ANNOUNCEMENT] Failed to announce vacancy for office ${office.id}:`, error);
        }
      }

      return interaction.reply({
        embeds: [successEmbed('Office Vacated', `<@${prevHolder}> has been removed from **${office.name}**.${roleError ? '\n\n⚠️ The database was updated, but the Discord role could not be removed. Check the bot role hierarchy and permissions.' : ''}`, gid)]
      });
    }

    // ── /office delete ────────────────────────────────────────────────────
    if (sub === 'delete') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }

      if (!interaction.options.getBoolean('confirm')) {
        return interaction.reply({
          embeds: [errorEmbed('Deletion cancelled. Set `confirm: True` to permanently delete this office.')],
          flags: 64
        });
      }

      const officeName = interaction.options.getString('office');
      const office     = stmtGetOffice.get(gid, officeName);
      if (!office) return interaction.reply({ embeds: [errorEmbed(`Office **${officeName}** not found.`)], flags: 64 });

      db.transaction(() => {
        if (office.holder_id && office.assumed_at) {
          stmtInsertHistory.run(gid, office.name, office.holder_id, office.assumed_at, Math.floor(Date.now() / 1000), 'office_deleted');
        }
        stmtDeleteOffice.run(office.id);
        logActivity(gid, 'OFFICE_DELETED', uid, office.name, null);
      })();
      const roleError = office.holder_id
        ? await removeRole(interaction.guild, office.holder_id, office.role_id)
        : null;

      const vacateNote = office.holder_id
        ? `\n<@${office.holder_id}> has been removed from the position.${roleError ? '\n⚠️ The Discord role could not be removed; check the bot role hierarchy and permissions.' : ' Their role was stripped.'}`
        : '';

      return interaction.reply({
        embeds: [successEmbed(
          'Office Deleted',
          `The office of **${office.name}** has been permanently removed.${vacateNote}`,
          gid
        )]
      });
    }

    // ── /office info ──────────────────────────────────────────────────────
    if (sub === 'info') {
      const officeName = interaction.options.getString('office');
      const office     = stmtGetOffice.get(gid, officeName);
      if (!office) return interaction.reply({ embeds: [errorEmbed(`Office **${officeName}** not found.`)], flags: 64 });

      const history = db.prepare(
        'SELECT * FROM office_history WHERE guild_id = ? AND office_name = ? ORDER BY vacated_at DESC LIMIT 5'
      ).all(gid, office.name);

      const historyText = history.length
        ? history.map(h => `<@${h.user_id}> — <t:${h.assumed_at}:d> → <t:${h.vacated_at}:d> *(${h.reason})*`).join('\n')
        : '*No history yet.*';

      const holderText = office.holder_id
        ? `<@${office.holder_id}>${office.assumed_at ? ` (since <t:${office.assumed_at}:D>)` : ''}`
        : '*Vacant*';

      const limit = stmtTermLimit.get(gid, office.name);
      const termsField = limit ? `${limit.max_terms} max` : 'No limit';

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🏛️ ${office.name}`)
        .setDescription(office.description || '*No description.*')
        .addFields(
          { name: '📋 Type',           value: typeBadge(office),                              inline: true },
          { name: '⏱️ Term',           value: termLabel(office),                              inline: true },
          { name: '🔁 Term Limits',    value: termsField,                                     inline: true },
          { name: '👤 Current Holder', value: holderText,                                     inline: false },
          { name: '🎭 Role',           value: office.role_id ? `<@&${office.role_id}>` : 'None', inline: true },
          { name: '📜 Recent History', value: historyText }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    // ── /office list ──────────────────────────────────────────────────────
    if (sub === 'list') {
      const offices = stmtAllOffices.all(gid);

      if (offices.length === 0) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🏛️ Government Offices')
            .setDescription('No offices have been created yet. Use `/office create` to get started.')]
        });
      }

      const permanent = offices.filter(o => o.is_permanent);
      const elected   = offices.filter(o => !o.is_permanent && o.is_elected);
      const appointed = offices.filter(o => !o.is_permanent && !o.is_elected);

      function fmt(o) {
        const holder = o.holder_id ? `<@${o.holder_id}>` : '*Vacant*';
        return `**${o.name}** — ${holder} *(${termLabel(o)})*`;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🏛️ Government Offices & Positions')
        .setFooter({ text: `${offices.length} office${offices.length !== 1 ? 's' : ''} total` })
        .setTimestamp();

      if (permanent.length) embed.addFields({ name: '📌 Permanent Offices', value: permanent.map(fmt).join('\n') });
      if (elected.length)   embed.addFields({ name: '🗳️ Elected Offices',   value: elected.map(fmt).join('\n') });
      if (appointed.length) embed.addFields({ name: '👑 Appointed Offices', value: appointed.map(fmt).join('\n') });

      return interaction.reply({ embeds: [embed] });
    }
  }
};
