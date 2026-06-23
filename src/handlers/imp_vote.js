// Handler: impeachment vote buttons
// customId format: imp_vote:<impeachment_id>:<vote>
import { EmbedBuilder } from 'discord.js';
import { errorEmbed } from '../utils/embeds.js';
import { castImpeachmentVote } from '../utils/voting.js';

export async function handle(interaction, parts) {
  const [impId, vote] = parts;
  const id = Number.parseInt(impId, 10);
  const result = castImpeachmentVote(interaction.guildId, id, interaction.user.id, vote);
  if (!result.ok) return interaction.reply({ embeds: [errorEmbed(result.reason)], flags: 64 });

  const decisive = result.tally.convict + result.tally.acquit;
  const cPct = decisive ? ((result.tally.convict / decisive) * 100).toFixed(1) : '0.0';
  const aPct = decisive ? ((result.tally.acquit / decisive) * 100).toFixed(1) : '0.0';
  const label = { convict: '⚖️ CONVICT', acquit: '🛡️ ACQUIT', abstain: '⬛ ABSTAIN' };
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('⚖️ Vote Recorded')
      .setDescription(`You voted **${label[vote]}** in the impeachment trial of <@${result.proceeding.target_id}>.`)
      .addFields(
        { name: '⚖️ Convict', value: `${result.tally.convict} (${cPct}%)`, inline: true },
        { name: '🛡️ Acquit', value: `${result.tally.acquit} (${aPct}%)`, inline: true },
        { name: '⬛ Abstain', value: `${result.tally.abstain}`, inline: true },
      )
      .setFooter({ text: 'Use /impeach conclude to tally the final result' })],
    flags: 64,
  });
}
