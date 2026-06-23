// Handler: poll vote select menu
// customId format: poll_vote:<poll_id>
// values[0] = option index as string
import { EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export async function handle(interaction, parts, config) {
  const pollId     = parseInt(parts[0], 10);
  const optionIndex = parseInt(interaction.values[0], 10);
  const gid        = interaction.guildId;
  const uid        = interaction.user.id;

  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND guild_id = ?').get(pollId, gid);
  if (!poll)                     return interaction.reply({ embeds: [errorEmbed(`Poll #${pollId} not found.`)], flags: 64 });
  if (poll.status !== 'active')  return interaction.reply({ embeds: [errorEmbed('This poll is no longer open.')], flags: 64 });

  const now = Math.floor(Date.now() / 1000);
  if (poll.ends_at && now > poll.ends_at) {
    db.prepare(`UPDATE polls SET status = 'closed' WHERE id = ?`).run(pollId);
    return interaction.reply({ embeds: [errorEmbed('This poll has already closed.')], flags: 64 });
  }

  const options = JSON.parse(poll.options);
  if (optionIndex < 0 || optionIndex >= options.length) {
    return interaction.reply({ embeds: [errorEmbed('Invalid option.')], flags: 64 });
  }

  const existing = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? AND voter_id = ?').get(pollId, uid);
  const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

  const changed = Boolean(existing);
  if (existing) {
    if (existing.option_index === optionIndex) {
      return interaction.reply({ embeds: [errorEmbed(`You already voted for **${options[optionIndex]}**.`)], flags: 64 });
    }
    db.prepare('UPDATE poll_votes SET option_index = ?, voted_at = ? WHERE poll_id = ? AND voter_id = ?')
      .run(optionIndex, now, pollId, uid);
  } else {
    db.prepare('INSERT INTO poll_votes (poll_id, voter_id, option_index) VALUES (?, ?, ?)').run(pollId, uid, optionIndex);
  }

  // Live bar chart in response
  const allVotes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ?').all(pollId);
  const total    = allVotes.length;
  const counts   = new Array(options.length).fill(0);
  for (const v of allVotes) counts[v.option_index]++;

  const lines = options.map((opt, i) => {
    const pct    = total > 0 ? ((counts[i] / total) * 100).toFixed(1) : '0.0';
    const filled = Math.round(parseFloat(pct) / 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const you    = i === optionIndex ? ' ← you' : '';
    return `${NUM_EMOJI[i]} **${opt}**\n\`${bar}\` ${counts[i]} (${pct}%)${you}`;
  }).join('\n\n');

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📊 ${changed ? 'Vote Changed' : 'Vote Cast'} — ${poll.title}`)
      .setDescription(changed
        ? `Changed from **${options[existing.option_index]}** to **${options[optionIndex]}**.\n\n${lines}`
        : lines)
      .setFooter({ text: `${total} total vote${total !== 1 ? 's' : ''} · Poll #${pollId}` })],
    flags: 64
  });
}
