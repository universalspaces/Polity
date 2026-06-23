/**
 * commands/setup.js — Interactive guided setup wizard.
 *
 * Uses native Discord components:
 *   ChannelSelectMenu  → no manual fetching, no 25-entry limit, auto-filtered to text channels
 *   RoleSelectMenu     → shows all server roles natively
 *   Modal              → for text inputs (name, oath, defaults)
 *   Buttons            → for binary toggles (citizenship gate)
 *
 * Flow:
 *   /setup
 *     └─ Main menu (ephemeral) — shows current config at a glance
 *          ├─ 🏛️ Government Name  → Modal
 *          ├─ 📡 Channels         → 4× ChannelSelectMenu (one per slot, saves on select)
 *          ├─ ⚙️ Defaults         → Modal (election hours + initiative signatures)
 *          ├─ 🗳️ Parliament Role  → RoleSelectMenu  +  🗑️ Clear button
 *          ├─ 📜 Citizenship Oath → Modal (paragraph)
 *          └─ 🪪 Citizenship Gate → ✅ Enable  /  ❌ Disable
 *
 * Routing in index.js:
 *   customId "setup_*"        → routeHandler → handle()
 *   customId "setup_*_submit" → routeModal   → handleModal()
 */

import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import db from '../database.js';
import { Colors, makeEmbed, replyError } from '../utils/embeds.js';

// ── Slash command ─────────────────────────────────────────────────────────────

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Polity for your server — opens an interactive wizard')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return replyError(interaction, 'You need **Administrator** permission.');
    }
    return showMainMenu(interaction, true);
  },
};

// ── Main menu ─────────────────────────────────────────────────────────────────

export async function showMainMenu(interaction, isNew = false) {
  const gid    = interaction.guildId;
  const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

  const embed = makeEmbed(Colors.primary)
    .setTitle('⚙️ Polity Setup Wizard')
    .setDescription(
      `Configuration for **${config?.government_name ?? 'your government'}**.\n` +
      `Select a category below to configure it.\u200b`
    )
    .addFields(
      { name: '🏛️ Government Name',    value: config?.government_name       ?? '*Not set*',                                                     inline: true },
      { name: '🪪 Citizenship Gate',   value: config?.require_citizenship    ? '✅ Required' : '❌ Optional',                                    inline: true },
      { name: '🗳️ Parliament Role',    value: config?.parliament_role        ? `<@&${config.parliament_role}>` : '*Any citizen*',               inline: true },
      { name: '🗳️ Elections Channel',  value: config?.election_channel       ? `<#${config.election_channel}>`       : '*Not set*',             inline: true },
      { name: '📢 Announcements',      value: config?.announcement_channel   ? `<#${config.announcement_channel}>`   : '*Not set*',             inline: true },
      { name: '⚖️ Court Channel',      value: config?.court_channel          ? `<#${config.court_channel}>`          : '*Not set*',             inline: true },
      { name: '🏛️ Legislature',        value: config?.legislature_channel    ? `<#${config.legislature_channel}>`    : '*Not set*',             inline: true },
      { name: '⏱️ Election Duration',  value: `${config?.election_duration_hours ?? 48} hours`,                                                 inline: true },
      { name: '✍️ Initiative Sigs',    value: `${config?.default_initiative_sigs ?? 10}`,                                                        inline: true },
      { name: '📜 Citizenship Oath',   value: config?.citizenship_oath
          ? `*${config.citizenship_oath.substring(0, 80)}${config.citizenship_oath.length > 80 ? '…' : ''}*`
          : '*Not set*' },
    )
    .setFooter({ text: 'All changes take effect immediately.' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_name').setLabel('Government Name').setEmoji('🏛️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_channels').setLabel('Channels').setEmoji('📡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_defaults').setLabel('Defaults').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_parliament').setLabel('Parliament Role').setEmoji('🗳️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_oath').setLabel('Citizenship Oath').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_citizenship').setLabel('Citizenship Gate').setEmoji('🪪').setStyle(ButtonStyle.Secondary),
  );

  const payload = { embeds: [embed], components: [row1, row2], flags: 64 };
  if (isNew)                                       return interaction.reply(payload);
  if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
  return interaction.update(payload);
}

// ── Button / select handler ───────────────────────────────────────────────────

export async function handle(interaction, parts, config) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Administrator permission required.', flags: 64 });
  }

  const action = parts[0] ?? '';
  const gid    = interaction.guildId;

  // ── Government name modal ────────────────────────────────────────────────
  if (action === 'name') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId('setup_name_submit')
        .setTitle('Set Government Name')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Government name')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('e.g. The Federal Republic')
              .setValue(config?.government_name ?? '')
              .setMaxLength(80)
              .setRequired(true),
          ),
        ),
    );
  }

  // ── Channels: four ChannelSelectMenus, one per slot ──────────────────────
  if (action === 'channels') {
    const embed = makeEmbed(Colors.primary)
      .setTitle('📡 Configure Channels')
      .setDescription('Select a channel for each slot. Only text channels are shown.\nEach menu saves immediately on selection.')
      .addFields(
        { name: '🗳️ Elections',     value: config?.election_channel      ? `<#${config.election_channel}>`      : '*Not set*', inline: true },
        { name: '📢 Announcements', value: config?.announcement_channel  ? `<#${config.announcement_channel}>`  : '*Not set*', inline: true },
        { name: '⚖️ Court',         value: config?.court_channel         ? `<#${config.court_channel}>`         : '*Not set*', inline: true },
        { name: '🏛️ Legislature',   value: config?.legislature_channel   ? `<#${config.legislature_channel}>`   : '*Not set*', inline: true },
      );

    const rows = [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('setup_channels_set_election')
          .setPlaceholder('🗳️ Elections channel…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('setup_channels_set_announcement')
          .setPlaceholder('📢 Announcements channel…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('setup_channels_set_court')
          .setPlaceholder('⚖️ Court channel…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('setup_channels_set_legislature')
          .setPlaceholder('🏛️ Legislature channel…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      backButton(),
    ];

    return interaction.update({ embeds: [embed], components: rows, flags: 64 });
  }

  // ── Channels: channel selected → save immediately ────────────────────────
  if (action.startsWith('channels_set_')) {
    const slot    = action.replace('channels_set_', '');
    const colMap  = {
      election:     'election_channel',
      announcement: 'announcement_channel',
      court:        'court_channel',
      legislature:  'legislature_channel',
    };
    const labelMap = {
      election: '🗳️ Elections', announcement: '📢 Announcements',
      court: '⚖️ Court',        legislature: '🏛️ Legislature',
    };
    const col = colMap[slot];
    if (!col) return;

    if (interaction.values.length === 0) {
      db.prepare(`UPDATE server_config SET ${col} = NULL WHERE guild_id = ?`).run(gid);
      return showSuccess(interaction, `${labelMap[slot]} channel cleared.`);
    }
    const channelId = interaction.values[0];
    db.prepare(`UPDATE server_config SET ${col} = ? WHERE guild_id = ?`).run(channelId, gid);
    return showSuccess(interaction, `${labelMap[slot]} channel set to <#${channelId}>.`);
  }

  // ── Defaults modal ────────────────────────────────────────────────────────
  if (action === 'defaults') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId('setup_defaults_submit')
        .setTitle('Set Default Values')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('election_hours')
              .setLabel('Default election duration (hours)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('48')
              .setValue(String(config?.election_duration_hours ?? 48))
              .setMaxLength(4)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('initiative_sigs')
              .setLabel('Default signatures required for initiatives')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('10')
              .setValue(String(config?.default_initiative_sigs ?? 10))
              .setMaxLength(4)
              .setRequired(true),
          ),
        ),
    );
  }

  // ── Parliament role: RoleSelectMenu + clear button ───────────────────────
  if (action === 'parliament') {
    const embed = makeEmbed(Colors.primary)
      .setTitle('🗳️ Parliament Role')
      .setDescription(
        'Set which role is allowed to vote on bills in the legislature.\n' +
        'Leave unset to allow **any registered citizen** to vote.\n\n' +
        `**Current:** ${config?.parliament_role ? `<@&${config.parliament_role}>` : '*Any citizen*'}`
      );

    const selectRow = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('setup_parliament_set')
        .setPlaceholder('Select a role…')
        .setMinValues(0).setMaxValues(1),
    );
    const btnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup_parliament_clear').setLabel('Clear Role').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('setup_back').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    );

    return interaction.update({ embeds: [embed], components: [selectRow, btnRow], flags: 64 });
  }

  if (action === 'parliament_set') {
    if (interaction.values.length === 0) {
      db.prepare('UPDATE server_config SET parliament_role = NULL WHERE guild_id = ?').run(gid);
      return showSuccess(interaction, 'Parliament role cleared.\nAny registered citizen can now vote on bills.');
    }
    const roleId = interaction.values[0];
    db.prepare('UPDATE server_config SET parliament_role = ? WHERE guild_id = ?').run(roleId, gid);
    return showSuccess(interaction, `Parliament role set to <@&${roleId}>.\nOnly members with this role can vote on bills.`);
  }

  if (action === 'parliament_clear') {
    db.prepare('UPDATE server_config SET parliament_role = NULL WHERE guild_id = ?').run(gid);
    return showSuccess(interaction, 'Parliament role cleared.\nAny registered citizen can vote on bills.');
  }

  // ── Citizenship oath modal ────────────────────────────────────────────────
  if (action === 'oath') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId('setup_oath_submit')
        .setTitle('Set Citizenship Oath')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('oath')
              .setLabel('Oath text (leave empty to clear)')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('I pledge to uphold the laws of this Republic…')
              .setValue(config?.citizenship_oath ?? '')
              .setMaxLength(1000)
              .setRequired(false),
          ),
        ),
    );
  }

  // ── Citizenship gate: enable / disable buttons ───────────────────────────
  if (action === 'citizenship') {
    const current = !!config?.require_citizenship;
    const embed   = makeEmbed(Colors.primary)
      .setTitle('🪪 Citizenship Gate')
      .setDescription(
        'When **enabled**, users must run `/citizen register` before they can\n' +
        'vote, join parties, propose bills, or sign initiatives.\n\n' +
        `**Current status:** ${current ? '✅ Required' : '❌ Optional'}`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('setup_citizenship_on')
        .setLabel('Enable')
        .setEmoji('✅')
        .setStyle(current ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(current),
      new ButtonBuilder()
        .setCustomId('setup_citizenship_off')
        .setLabel('Disable')
        .setEmoji('❌')
        .setStyle(current ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(!current),
      new ButtonBuilder().setCustomId('setup_back').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ embeds: [embed], components: [row], flags: 64 });
  }

  if (action === 'citizenship_on') {
    db.prepare('UPDATE server_config SET require_citizenship = 1 WHERE guild_id = ?').run(gid);
    return showSuccess(interaction, '✅ Citizenship gate **enabled**.\nUsers must run `/citizen register` before participating.');
  }

  if (action === 'citizenship_off') {
    db.prepare('UPDATE server_config SET require_citizenship = 0 WHERE guild_id = ?').run(gid);
    return showSuccess(interaction, '❌ Citizenship gate **disabled**.\nAnyone can use civic commands without registering.');
  }

  // ── Back to main menu ─────────────────────────────────────────────────────
  if (action === 'back') {
    return showMainMenu(interaction);
  }
}

// ── Modal submit handler ──────────────────────────────────────────────────────

export async function handleModal(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const gid = interaction.guildId;
  const id  = interaction.customId;

  if (id === 'setup_name_submit') {
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) return interaction.reply({ content: '❌ Name cannot be empty.', flags: 64 });
    db.prepare('UPDATE server_config SET government_name = ? WHERE guild_id = ?').run(name, gid);
    await interaction.deferUpdate().catch(() => {});
    return showMainMenu(interaction);
  }

  if (id === 'setup_defaults_submit') {
    const hours = parseInt(interaction.fields.getTextInputValue('election_hours'), 10);
    const sigs  = parseInt(interaction.fields.getTextInputValue('initiative_sigs'),  10);
    if (isNaN(hours) || hours < 1 || hours > 720)
      return interaction.reply({ content: '❌ Election hours must be between 1 and 720.', flags: 64 });
    if (isNaN(sigs) || sigs < 1 || sigs > 500)
      return interaction.reply({ content: '❌ Signature count must be between 1 and 500.', flags: 64 });
    db.prepare('UPDATE server_config SET election_duration_hours = ?, default_initiative_sigs = ? WHERE guild_id = ?').run(hours, sigs, gid);
    await interaction.deferUpdate().catch(() => {});
    return showMainMenu(interaction);
  }

  if (id === 'setup_oath_submit') {
    const text = interaction.fields.getTextInputValue('oath').trim();
    if (text) {
      db.prepare('UPDATE server_config SET citizenship_oath = ? WHERE guild_id = ?').run(text, gid);
    } else {
      db.prepare('UPDATE server_config SET citizenship_oath = NULL WHERE guild_id = ?').run(gid);
    }
    await interaction.deferUpdate().catch(() => {});
    return showMainMenu(interaction);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function backButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup_back')
      .setLabel('Back to Menu')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function showSuccess(interaction, description) {
  await interaction.update({
    embeds: [makeEmbed(Colors.success)
      .setTitle('✅ Saved')
      .setDescription(description)
      .setFooter({ text: 'Use the button below to return to the setup menu.' })],
    components: [backButton()],
    flags: 64,
  });
}
