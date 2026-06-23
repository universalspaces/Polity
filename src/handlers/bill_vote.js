/**
 * handlers/bill_vote.js
 * customId format: bill_vote:<bill_id>:<vote>
 *
 * Uses the shared castBillVote() from utils/voting — identical logic to
 * the /bill vote slash command, so no risk of drift.
 */

import { EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { replyError, logActivity } from '../utils/embeds.js';
import { castBillVote, voteLabel, voteEmoji } from '../utils/voting.js';

export async function handle(interaction, parts, config) {
  const [billIdStr, vote] = parts;
  const billId = parseInt(billIdStr, 10);
  const gid    = interaction.guildId;
  const uid    = interaction.user.id;

  // Parliament role / citizenship check
  if (config?.parliament_role) {
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member?.roles.cache.has(config.parliament_role)) {
      return replyError(interaction, `Only members of <@&${config.parliament_role}> can vote on bills.`);
    }
  }

  const result = castBillVote(gid, billId, uid, vote);
  if (!result.ok) return replyError(interaction, result.reason);

  const bill    = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  const total   = bill.votes_yes + bill.votes_no + bill.votes_abstain;
  const desc    = result.changed
    ? `Changed from **${voteLabel(result.previous)}** to **${voteLabel(vote)}** on Bill #${billId}: **${bill.title}**`
    : `You voted **${voteLabel(vote)}** on Bill #${billId}: **${bill.title}**`;

  logActivity(gid, 'BILL_VOTE_BUTTON', uid, `Bill #${billId}`, vote);

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57F287).setTimestamp()
      .setTitle(result.changed ? '📜 Vote Changed' : '📜 Vote Recorded')
      .setDescription(desc)
      .addFields(
        { name: '✅ Yea',     value: `${bill.votes_yes}`,     inline: true },
        { name: '❌ Nay',     value: `${bill.votes_no}`,      inline: true },
        { name: '⬛ Abstain', value: `${bill.votes_abstain}`, inline: true },
      )
      .setFooter({ text: `${total} total vote${total !== 1 ? 's' : ''} cast` })],
    flags: 64,
  });
}
