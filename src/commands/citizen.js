import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, infoEmbed, listEmbeds, logActivity, replyError, ts } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('citizen')
    .setDescription('Citizen registration and profiles')
    .addSubcommand(s => s
      .setName('register')
      .setDescription('Register as a citizen of this government'))
    .addSubcommand(s => s
      .setName('profile')
      .setDescription('View a citizen profile')
      .addUserOption(o => o.setName('user').setDescription('User to view (defaults to yourself)')))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all registered citizens')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'register') {
      const existing = db.prepare('SELECT 1 FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (existing) return replyError(interaction, 'You are already a registered citizen.');

      const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
      const count  = db.prepare('SELECT COUNT(*) as c FROM citizens WHERE guild_id = ?').get(gid).c;
      const num    = count + 1;
      db.prepare('INSERT INTO citizens (guild_id, user_id, citizen_number) VALUES (?, ?, ?)').run(gid, uid, num);
      logActivity(gid, 'CITIZEN_REGISTERED', uid, null, `Citizen #${num}`);

      const welcome = new EmbedBuilder()
        .setColor(0x57F287).setTimestamp()
        .setTitle('🎉 Welcome, Citizen!')
        .setDescription(`You are now **Citizen #${num}** of **${config?.government_name || 'the Republic'}**.`)
        .addFields({ name: '🗳️ Your Rights', value: '• Vote in elections\n• Join a political party\n• Propose citizens\' initiatives\n• File court cases\n• Sign recall petitions' });

      const embeds = [];
      if (config?.citizenship_oath) {
        embeds.push(new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📜 Citizenship Oath')
          .setDescription(config.citizenship_oath)
          .setFooter({ text: 'By registering, you swear to uphold the above oath.' }));
      }
      embeds.push(welcome);
      return interaction.reply({ embeds });
    }

    if (sub === 'profile') {
      const target  = interaction.options.getUser('user') ?? interaction.user;
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      if (!citizen) return replyError(interaction, `${target.username} is not a registered citizen.`);

      const party         = db.prepare('SELECT p.* FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.guild_id = ? AND pm.user_id = ?').get(gid, target.id);
      const offices       = db.prepare('SELECT name FROM offices WHERE guild_id = ? AND holder_id = ?').all(gid, target.id);
      const electionsWon  = db.prepare('SELECT COUNT(*) as c FROM elections WHERE guild_id = ? AND winner_id = ?').get(gid, target.id).c;
      const billsPassed   = db.prepare("SELECT COUNT(*) as c FROM bills WHERE guild_id = ? AND sponsor_id = ? AND status = 'passed'").get(gid, target.id).c;
      const isJudge       = db.prepare('SELECT 1 FROM judges WHERE guild_id = ? AND user_id = ? AND is_active = 1').get(gid, target.id);

      const embed = new EmbedBuilder()
        .setColor(0x5865F2).setTimestamp()
        .setTitle(`🪪 Citizen Profile: ${target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🆔 Citizen Number', value: `#${citizen.citizen_number}`,                                    inline: true },
          { name: '⭐ Reputation',     value: `${citizen.reputation >= 0 ? '+' : ''}${citizen.reputation}`,   inline: true },
          { name: '📅 Registered',     value: ts(citizen.registered_at, 'D'),                                  inline: true },
          { name: '🏛️ Party',         value: party ? `${party.emoji} ${party.name}` : 'Independent',          inline: true },
          { name: '🏆 Elections Won',  value: `${electionsWon}`,                                               inline: true },
          { name: '📜 Bills Passed',   value: `${billsPassed}`,                                                inline: true },
        );

      if (isJudge)        embed.addFields({ name: '⚖️ Role',           value: '👨‍⚖️ Appointed Judge',               inline: true });
      if (offices.length) embed.addFields({ name: '💼 Current Offices', value: offices.map(o => `• ${o.name}`).join('\n') });

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const citizens = db.prepare(`
        SELECT c.*, p.name as party_name, p.emoji as party_emoji
        FROM citizens c
        LEFT JOIN party_members pm ON c.guild_id = pm.guild_id AND c.user_id = pm.user_id
        LEFT JOIN parties p ON pm.party_id = p.id
        WHERE c.guild_id = ?
        ORDER BY c.citizen_number ASC
      `).all(gid);

      if (!citizens.length) return interaction.reply({ embeds: [infoEmbed('🪪 Citizens', 'No citizens registered yet.')] });

      const lines = citizens.map(c =>
        `**#${c.citizen_number}** <@${c.user_id}>${c.party_name ? ` — ${c.party_emoji} ${c.party_name}` : ' — Independent'}`
      );

      return interaction.reply({ embeds: listEmbeds('🪪 Registered Citizens', lines, {
        footer: `${citizens.length} citizen${citizens.length !== 1 ? 's' : ''} registered`,
      }) });
    }
  },
};
