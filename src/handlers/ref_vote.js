// Handler: referendum vote buttons
// customId format: ref_vote:<referendum_id>:<vote>
import { EmbedBuilder } from 'discord.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { castReferendumVote } from '../utils/voting.js';

export async function handle(interaction, parts) {
  const [refId, vote] = parts;
  const id = Number.parseInt(refId, 10);
  const result = castReferendumVote(interaction.guildId, id, interaction.user.id, vote);
  if (!result.ok) return interaction.reply({ embeds: [errorEmbed(result.reason)], flags: 64 });

  const voteEmoji = { yes: '✅', no: '❌', abstain: '⬛' };
  if (result.changed) {
    return interaction.reply({
      embeds: [successEmbed(
        'Vote Changed',
        `Changed from **${voteEmoji[result.previous]} ${result.previous.toUpperCase()}** to **${voteEmoji[vote]} ${vote.toUpperCase()}** on Referendum #${id}: **${result.referendum.title}**`,
        interaction.guildId,
      )],
      flags: 64,
    });
  }

  const total = result.tally.yes + result.tally.no + result.tally.abstain;
  const yPct = total ? ((result.tally.yes / total) * 100).toFixed(1) : '0.0';
  const nPct = total ? ((result.tally.no / total) * 100).toFixed(1) : '0.0';
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🗳️ Vote Recorded')
      .setDescription(`You voted **${voteEmoji[vote]} ${vote.toUpperCase()}** on **${result.referendum.title}**.`)
      .addFields(
        { name: '✅ Yes', value: `${result.tally.yes} (${yPct}%)`, inline: true },
        { name: '❌ No', value: `${result.tally.no} (${nPct}%)`, inline: true },
        { name: '⬛ Abstain', value: `${result.tally.abstain}`, inline: true },
      )
      .setFooter({ text: `${total} total vote${total !== 1 ? 's' : ''}` })],
    flags: 64,
  });
}
