// Handler: party join select menu
// customId format: party_join
// values[0] = party id as string
import db from '../database.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export async function handle(interaction, parts, config) {
  const partyId = parseInt(interaction.values[0], 10);
  const gid     = interaction.guildId;
  const uid     = interaction.user.id;

  const party = db.prepare('SELECT * FROM parties WHERE id = ? AND guild_id = ? AND is_active = 1').get(partyId, gid);
  if (!party) return interaction.reply({ embeds: [errorEmbed('Party not found or no longer active.')], flags: 64 });

  const existing = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);
  if (existing)   return interaction.reply({ embeds: [errorEmbed('Leave your current party first with `/party leave`.')], flags: 64 });

  db.prepare('INSERT INTO party_members (guild_id, user_id, party_id, role) VALUES (?, ?, ?, ?)').run(gid, uid, party.id, 'member');

  const memberCount = db.prepare('SELECT COUNT(*) as cnt FROM party_members WHERE party_id = ?').get(party.id).cnt;

  return interaction.reply({
    embeds: [successEmbed(
      'Party Joined',
      `You joined **${party.emoji} ${party.name}** (${party.abbreviation})!\n\n🧭 Ideology: ${party.ideology || 'Unspecified'}\n👥 Members: ${memberCount}`,
      gid
    )],
    flags: 64
  });
}
