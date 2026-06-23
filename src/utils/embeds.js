/**
 * utils/embeds.js — Shared embed builders, auth guards, and logging helpers.
 *
 * Rules:
 *  - No DB calls in embed helpers; callers pass data in.
 *  - requireCitizen / requireAdmin return false and reply when the check fails,
 *    so callers can just `if (!await requireX(i)) return;`.
 */

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { q } from '../database.js';
import { BRAND_NAME, chunkLines, normalizeFooter, safeField, truncateText } from './presentation.js';

// ── Colour palette ────────────────────────────────────────────────────────────
export const Colors = {
  primary:  0x5865F2, // blurple
  success:  0x57F287, // green
  danger:   0xED4245, // red
  warning:  0xFEE75C, // yellow
  neutral:  0x2B2D31, // dark
  info:     0x5DADE2, // light blue
};

// ── Core builders ─────────────────────────────────────────────────────────────

export function makeEmbed(color = Colors.neutral) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

/**
 * successEmbed(title, description, govName?)
 * Builds a green "✅ Success" embed. govName is used in the footer.
 */
export function successEmbed(title, description, govName = 'Polity') {
  return makeEmbed(Colors.success)
    .setTitle(`✅ ${title}`)
    .setDescription(truncateText(description, 4096))
    .setFooter({ text: normalizeFooter(govName) });
}

/**
 * errorEmbed(description)
 * Builds a red "❌ Error" embed.
 */
export function errorEmbed(description) {
  return makeEmbed(Colors.danger)
    .setTitle('❌ Couldn\'t complete that')
    .setDescription(truncateText(description, 4096));
}

/**
 * infoEmbed(title, description, govName?)
 * Builds a blurple informational embed.
 */
export function infoEmbed(title, description, govName = 'Polity') {
  return makeEmbed(Colors.primary)
    .setTitle(title)
    .setDescription(truncateText(description, 4096))
    .setFooter({ text: normalizeFooter(govName) });
}

/**
 * warningEmbed(title, description)
 * Builds a yellow caution embed.
 */
export function warningEmbed(title, description) {
  return makeEmbed(Colors.warning)
    .setTitle(`⚠️ ${title}`)
    .setDescription(description);
}

export function resultEmbed(title, description, status = 'neutral', footer = BRAND_NAME) {
  const color = { passed: Colors.success, completed: Colors.success, tied: Colors.warning, pending: Colors.warning, failed: Colors.danger, rejected: Colors.danger, closed: Colors.neutral }[status] ?? Colors.primary;
  return makeEmbed(color)
    .setTitle(title)
    .setDescription(truncateText(description, 4096))
    .addFields(safeField('📋 Status', String(status).replaceAll('_', ' ').toUpperCase(), true))
    .setFooter({ text: normalizeFooter(footer) });
}

export function ledgerEmbed(title, lines, footer = BRAND_NAME) {
  return makeEmbed(Colors.warning)
    .setTitle(title)
    .setDescription(chunkLines(lines, 3900, 1)[0])
    .setFooter({ text: normalizeFooter(footer) });
}

export function listEmbeds(title, lines, { color = Colors.primary, footer = BRAND_NAME } = {}) {
  const pages = chunkLines(lines);
  return pages.map((description, index) => makeEmbed(color)
    .setTitle(pages.length > 1 ? `${title} · ${index + 1}/${pages.length}` : title)
    .setDescription(description)
    .setFooter({ text: normalizeFooter(footer) }));
}

export function statusField(status, nextAction) {
  const value = nextAction ? `**${String(status).toUpperCase()}**\n${nextAction}` : `**${String(status).toUpperCase()}**`;
  return safeField('📋 Status', value, true);
}

// ── Reply helpers ─────────────────────────────────────────────────────────────

/** Reply with an ephemeral error embed. */
export async function replyError(interaction, description) {
  const payload = { embeds: [errorEmbed(description)], flags: 64 };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload).catch(() => {});
  }
  return interaction.reply(payload).catch(() => {});
}

/** Reply with an ephemeral success embed. */
export async function replySuccess(interaction, title, description, govName) {
  const payload = { embeds: [successEmbed(title, description, govName)], flags: 64 };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload).catch(() => {});
  }
  return interaction.reply(payload).catch(() => {});
}

// ── Auth guards ───────────────────────────────────────────────────────────────

/** Returns true if the member has ManageGuild (admin). */
export function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Checks if the user is a registered citizen.
 * Replies with an ephemeral error and returns false when they are not.
 */
export async function requireCitizen(interaction) {
  if (q.hasCitizen.get(interaction.guildId, interaction.user.id)) return true;
  await replyError(
    interaction,
    'You must register as a citizen first.\nUse `/citizen register` to get started.',
  );
  return false;
}

/**
 * Checks if the member has ManageGuild.
 * Replies with an ephemeral error and returns false when they do not.
 */
export async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;
  await replyError(interaction, 'You need **Manage Server** permission to use this command.');
  return false;
}

// ── Logging ───────────────────────────────────────────────────────────────────

export function logActivity(guildId, action, actorId, target = null, details = null) {
  try { q.logActivity.run(guildId, action, actorId, target, details); } catch (err) { console.warn(`[ACTIVITY_LOG ${action}]`, err); }
}

export function logAdmin(guildId, adminId, action, target = null, reason = null, details = null) {
  try {
    q.logAdmin.run(guildId, adminId, action, target, reason, details);
    logActivity(guildId, `ADMIN_${action}`, adminId, target, reason);
  } catch (err) {
    console.warn(`[ADMIN_LOG ${action}]`, err);
  }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

/** Discord timestamp string, e.g. <t:1234567890:F> */
export function ts(unixSeconds, style = 'F') {
  return `<t:${Math.floor(unixSeconds)}:${style}>`;
}

/** Current time as Unix seconds. */
export function now() {
  return Math.floor(Date.now() / 1000);
}

/** Truncate a string with an ellipsis if it exceeds maxLen. */
export function truncate(str, maxLen = 1000) {
  return truncateText(str, maxLen);
}

/** Parse a hex color string to an integer. */
export function parseColor(hex, fallback = Colors.primary) {
  const parsed = parseInt((hex ?? '').replace('#', ''), 16);
  return isNaN(parsed) ? fallback : parsed;
}

/** Format a party's embed. */
export function partyEmbed(party) {
  return makeEmbed(parseColor(party.color))
    .setTitle(`${party.emoji} ${party.name} (${party.abbreviation})`)
    .setDescription(party.description ?? '*No description set.*')
    .addFields(
      { name: '🧭 Ideology', value: party.ideology || 'Unspecified', inline: true },
      { name: '📅 Founded',  value: ts(party.founded_at, 'D'),        inline: true },
    );
}
