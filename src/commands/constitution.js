import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, listEmbeds, truncate } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('constitution')
    .setDescription('Manage the government constitution')
    .addSubcommand(s => s
      .setName('add')
      .setDescription('Add a constitutional article (Admin only)')
      .addIntegerOption(o => o.setName('article').setDescription('Article number').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Article title').setRequired(true))
      .addStringOption(o => o.setName('content').setDescription('Article content').setRequired(true)))
    .addSubcommand(s => s
      .setName('view')
      .setDescription('View a constitutional article')
      .addIntegerOption(o => o.setName('article').setDescription('Article number (omit to see all)').setRequired(false)))
    .addSubcommand(s => s
      .setName('repeal')
      .setDescription('Repeal a constitutional article (Admin only)')
      .addIntegerOption(o => o.setName('article').setDescription('Article number').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    if (sub === 'add') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }
      const articleNum = interaction.options.getInteger('article');
      const title = interaction.options.getString('title');
      const content = interaction.options.getString('content');

      const existing = db.prepare('SELECT * FROM constitution WHERE guild_id = ? AND article_number = ? AND is_active = 1').get(gid, articleNum);
      if (existing) {
        db.prepare('UPDATE constitution SET is_active = 0 WHERE guild_id = ? AND article_number = ?').run(gid, articleNum);
      }

      db.prepare('INSERT INTO constitution (guild_id, article_number, title, content, ratified_by) VALUES (?, ?, ?, ?, ?)')
        .run(gid, articleNum, title, content, uid);

      return interaction.reply({ embeds: [successEmbed('Article Ratified', `**Article ${articleNum}: ${title}** has been added to the constitution.`, gid)] });
    }

    if (sub === 'view') {
      const articleNum = interaction.options.getInteger('article');

      if (articleNum) {
        const article = db.prepare('SELECT * FROM constitution WHERE guild_id = ? AND article_number = ? AND is_active = 1').get(gid, articleNum);
        if (!article) return interaction.reply({ embeds: [errorEmbed(`Article ${articleNum} not found.`)], flags: 64 });

        return interaction.reply({ embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`📜 Constitution of ${config?.government_name || 'the Republic'}`)
            .setDescription(truncate(`**Article ${article.article_number}: ${article.title}**\n\n${article.content}`, 4096))
            .setFooter({ text: `Ratified <t:${article.ratified_at}:D>` })
        ]});
      }

      // Show all
      const articles = db.prepare('SELECT * FROM constitution WHERE guild_id = ? AND is_active = 1 ORDER BY article_number').all(gid);
      if (articles.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Constitution').setDescription('No articles have been ratified yet.')] });

      const lines = articles.map(a => `**Art. ${a.article_number}:** ${a.title}`);
      return interaction.reply({ embeds: listEmbeds(`📜 Constitution of ${config?.government_name || 'the Republic'}`, lines, {
        footer: `${articles.length} article(s) • Use /constitution view article:<number> to read`,
      }) });
    }

    if (sub === 'repeal') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('Administrator permissions required.')], flags: 64 });
      }
      const articleNum = interaction.options.getInteger('article');
      const article = db.prepare('SELECT * FROM constitution WHERE guild_id = ? AND article_number = ? AND is_active = 1').get(gid, articleNum);
      if (!article) return interaction.reply({ embeds: [errorEmbed(`Article ${articleNum} not found.`)], flags: 64 });

      db.prepare('UPDATE constitution SET is_active = 0 WHERE guild_id = ? AND article_number = ?').run(gid, articleNum);
      return interaction.reply({ embeds: [successEmbed('Article Repealed', `**Article ${articleNum}: ${article.title}** has been repealed from the constitution.`, gid)] });
    }
  }
};
