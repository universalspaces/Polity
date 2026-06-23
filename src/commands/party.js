import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import db from '../database.js';
import { errorEmbed, successEmbed, logActivity } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('party')
    .setDescription('Manage political parties')
    .addSubcommand(s => s
      .setName('create')
      .setDescription('Create a new political party')
      .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true))
      .addStringOption(o => o.setName('abbreviation').setDescription('Short abbreviation (e.g. GOP, LAB)').setRequired(true).setMaxLength(6))
      .addStringOption(o => o.setName('ideology').setDescription('Political ideology').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Party description'))
      .addStringOption(o => o.setName('color').setDescription('Hex color (e.g. #FF0000)'))
      .addStringOption(o => o.setName('emoji').setDescription('Party emoji')))
    .addSubcommand(s => s
      .setName('join')
      .setDescription('Join a political party')
      .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true)))
    .addSubcommand(s => s
      .setName('leave')
      .setDescription('Leave your current party'))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View party information')
      .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List all parties'))
    .addSubcommand(s => s
      .setName('members')
      .setDescription('View party members')
      .addStringOption(o => o.setName('name').setDescription('Party name').setRequired(true)))
    .addSubcommand(s => s
      .setName('promote')
      .setDescription('Promote a party member (leader only)')
      .addUserOption(o => o.setName('member').setDescription('Member to promote').setRequired(true))
      .addStringOption(o => o.setName('role').setDescription('New role').setRequired(true)
        .addChoices({ name: 'Officer', value: 'officer' }, { name: 'Member', value: 'member' })))
    .addSubcommand(s => s
      .setName('transfer')
      .setDescription('Transfer party leadership to another member (leader only)')
      .addUserOption(o => o.setName('member').setDescription('Member to transfer leadership to').setRequired(true)))
    .addSubcommand(s => s
      .setName('disband')
      .setDescription('Disband your party (leader only)')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (sub === 'create') {
      const name = interaction.options.getString('name');
      const abbr = interaction.options.getString('abbreviation').toUpperCase();
      const ideology = interaction.options.getString('ideology');
      const desc = interaction.options.getString('description') || '';
      const color = interaction.options.getString('color') || '#5865F2';
      const emoji = interaction.options.getString('emoji') || '🏛️';

      const existing = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (existing) return interaction.reply({ embeds: [errorEmbed('You are already in a party. Leave it first with `/party leave`.')], flags: 64 });

      if (!/^#[0-9A-F]{6}$/i.test(color)) return interaction.reply({ embeds: [errorEmbed('Invalid hex color. Use format: #RRGGBB')], flags: 64 });

      try {
        const result = db.prepare(`INSERT INTO parties (guild_id, name, abbreviation, description, ideology, color, emoji, leader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(gid, name, abbr, desc, ideology, color, emoji, uid);
        db.prepare('INSERT INTO party_members (guild_id, user_id, party_id, role) VALUES (?, ?, ?, ?)').run(gid, uid, result.lastInsertRowid, 'leader');
        logActivity(gid, 'PARTY_CREATED', uid, name, ideology);
      } catch (e) {
        return interaction.reply({ embeds: [errorEmbed(`A party named **${name}** already exists.`)], flags: 64 });
      }

      const embed = new EmbedBuilder()
        .setColor(parseInt(color.replace('#', ''), 16))
        .setTitle(`${emoji} Party Founded: ${name} (${abbr})`)
        .setDescription(desc || '*No description.*')
        .addFields(
          { name: '🧭 Ideology', value: ideology, inline: true },
          { name: '👑 Leader', value: `<@${uid}>`, inline: true }
        );

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'join') {
      const name = interaction.options.getString('name');
      const party = db.prepare('SELECT * FROM parties WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND is_active = 1').get(gid, name);
      if (!party) return interaction.reply({ embeds: [errorEmbed(`Party **${name}** not found.`)], flags: 64 });

      const existing = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (existing) return interaction.reply({ embeds: [errorEmbed('Leave your current party first with `/party leave`.')], flags: 64 });

      db.prepare('INSERT INTO party_members (guild_id, user_id, party_id, role) VALUES (?, ?, ?, ?)').run(gid, uid, party.id, 'member');
      logActivity(gid, 'PARTY_JOIN', uid, party.name, '');

      return interaction.reply({ embeds: [successEmbed('Party Joined', `You joined **${party.emoji} ${party.name}**!`, gid)] });
    }

    if (sub === 'leave') {
      const membership = db.prepare('SELECT pm.*, p.name, p.emoji, p.leader_id, p.id as party_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.guild_id = ? AND pm.user_id = ?').get(gid, uid);
      if (!membership) return interaction.reply({ embeds: [errorEmbed('You are not in a party.')], flags: 64 });

      // If leader is leaving, auto-promote an officer or the longest-serving member
      if (membership.role === 'leader') {
        const nextLeader = db.prepare(`
          SELECT * FROM party_members
          WHERE party_id = ? AND user_id != ? AND role = 'officer'
          ORDER BY joined_at ASC LIMIT 1
        `).get(membership.party_id, uid)
        || db.prepare(`
          SELECT * FROM party_members
          WHERE party_id = ? AND user_id != ?
          ORDER BY joined_at ASC LIMIT 1
        `).get(membership.party_id, uid);

        if (nextLeader) {
          db.prepare('UPDATE party_members SET role = ? WHERE guild_id = ? AND user_id = ?').run('leader', gid, nextLeader.user_id);
          db.prepare('UPDATE parties SET leader_id = ? WHERE id = ?').run(nextLeader.user_id, membership.party_id);
          db.prepare('DELETE FROM party_members WHERE guild_id = ? AND user_id = ?').run(gid, uid);
          logActivity(gid, 'PARTY_LEAVE', uid, membership.name, `Leadership transferred to ${nextLeader.user_id}`);
          return interaction.reply({ embeds: [successEmbed('Party Left', `You left **${membership.emoji} ${membership.name}**.\n\nLeadership has been automatically transferred to <@${nextLeader.user_id}>.`, gid)] });
        } else {
          // No members left — disband
          db.prepare('DELETE FROM party_members WHERE party_id = ?').run(membership.party_id);
          db.prepare('UPDATE parties SET is_active = 0 WHERE id = ?').run(membership.party_id);
          logActivity(gid, 'PARTY_DISBANDED', uid, membership.name, 'Leader left with no members');
          return interaction.reply({ embeds: [successEmbed('Party Dissolved', `You were the last member of **${membership.emoji} ${membership.name}**, so it has been dissolved.`, gid)] });
        }
      }

      db.prepare('DELETE FROM party_members WHERE guild_id = ? AND user_id = ?').run(gid, uid);
      logActivity(gid, 'PARTY_LEAVE', uid, membership.name, '');
      return interaction.reply({ embeds: [successEmbed('Party Left', `You left **${membership.emoji} ${membership.name}**.`, gid)] });
    }

    if (sub === 'transfer') {
      const target = interaction.options.getUser('member');
      const myMembership = db.prepare('SELECT pm.*, p.id as party_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.guild_id = ? AND pm.user_id = ?').get(gid, uid);
      if (!myMembership || myMembership.role !== 'leader') return interaction.reply({ embeds: [errorEmbed('Only the party leader can transfer leadership.')], flags: 64 });
      if (target.id === uid) return interaction.reply({ embeds: [errorEmbed('You are already the leader.')], flags: 64 });

      const targetMembership = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ? AND party_id = ?').get(gid, target.id, myMembership.party_id);
      if (!targetMembership) return interaction.reply({ embeds: [errorEmbed('That user is not in your party.')], flags: 64 });

      db.prepare('UPDATE party_members SET role = ? WHERE guild_id = ? AND user_id = ?').run('member', gid, uid);
      db.prepare('UPDATE party_members SET role = ? WHERE guild_id = ? AND user_id = ?').run('leader', gid, target.id);
      db.prepare('UPDATE parties SET leader_id = ? WHERE id = ?').run(target.id, myMembership.party_id);
      logActivity(gid, 'PARTY_LEADERSHIP_TRANSFERRED', uid, target.id, '');

      return interaction.reply({ embeds: [successEmbed('Leadership Transferred', `<@${target.id}> is now the leader of the party.`, gid)] });
    }

    if (sub === 'info') {
      const name = interaction.options.getString('name');
      const party = db.prepare('SELECT * FROM parties WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND is_active = 1').get(gid, name);
      if (!party) return interaction.reply({ embeds: [errorEmbed(`Party **${name}** not found.`)], flags: 64 });

      const memberCount = db.prepare('SELECT COUNT(*) as cnt FROM party_members WHERE party_id = ?').get(party.id).cnt;
      const embed = new EmbedBuilder()
        .setColor(parseInt(party.color.replace('#', ''), 16) || 0x5865f2)
        .setTitle(`${party.emoji} ${party.name} (${party.abbreviation})`)
        .setDescription(party.description || '*No description.*')
        .addFields(
          { name: '🧭 Ideology', value: party.ideology || 'Unspecified', inline: true },
          { name: '👑 Leader', value: `<@${party.leader_id}>`, inline: true },
          { name: '👥 Members', value: `${memberCount}`, inline: true },
          { name: '📅 Founded', value: `<t:${party.founded_at}:D>`, inline: true }
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'list') {
      const parties = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM party_members WHERE party_id = p.id) as member_count FROM parties p WHERE p.guild_id = ? AND p.is_active = 1 ORDER BY member_count DESC').all(gid);
      if (parties.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🏛️ Political Parties').setDescription('No parties have been formed yet.')] });

      const list = parties.map(p => `${p.emoji} **${p.name}** (${p.abbreviation}) — ${p.member_count} member(s) | *${p.ideology}*`).join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🏛️ Political Parties')
        .setDescription(list)
        .setFooter({ text: 'Select a party below to join it' });

      // Only show join menu if user is not already in a party
      const existing = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!existing && parties.length <= 25) {
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('party_join')
          .setPlaceholder('Join a party…')
          .addOptions(parties.map(p =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${p.emoji} ${p.name} (${p.abbreviation})`)
              .setDescription(`${p.ideology || 'No ideology'} · ${p.member_count} member${p.member_count !== 1 ? 's' : ''}`)
              .setValue(String(p.id))
          ));
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
      }

      // Already in a party or too many parties for select menu — just show the list
      return interaction.reply({ embeds: [embed.setFooter({ text: existing ? 'Use /party leave first to join a different party' : '' })] });
    }

    if (sub === 'members') {
      const name = interaction.options.getString('name');
      const party = db.prepare('SELECT * FROM parties WHERE guild_id = ? AND LOWER(name) = LOWER(?) AND is_active = 1').get(gid, name);
      if (!party) return interaction.reply({ embeds: [errorEmbed(`Party **${name}** not found.`)], flags: 64 });

      const members = db.prepare('SELECT * FROM party_members WHERE party_id = ? ORDER BY role DESC').all(party.id);
      const roleEmoji = { leader: '👑', officer: '⭐', member: '▫️' };
      const list = members.map(m => `${roleEmoji[m.role] || '▫️'} <@${m.user_id}> — ${m.role}`).join('\n');

      return interaction.reply({ embeds: [new EmbedBuilder().setColor(parseInt(party.color.replace('#', ''), 16) || 0x5865f2).setTitle(`${party.emoji} ${party.name} — Members`).setDescription(list || 'No members.')] });
    }

    if (sub === 'promote') {
      const target = interaction.options.getUser('member');
      const newRole = interaction.options.getString('role');
      const myMembership = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ?').get(gid, uid);
      if (!myMembership || myMembership.role !== 'leader') return interaction.reply({ embeds: [errorEmbed('Only the party leader can promote members.')], flags: 64 });

      const targetMembership = db.prepare('SELECT * FROM party_members WHERE guild_id = ? AND user_id = ? AND party_id = ?').get(gid, target.id, myMembership.party_id);
      if (!targetMembership) return interaction.reply({ embeds: [errorEmbed('That user is not in your party.')], flags: 64 });

      db.prepare('UPDATE party_members SET role = ? WHERE guild_id = ? AND user_id = ?').run(newRole, gid, target.id);
      return interaction.reply({ embeds: [successEmbed('Member Promoted', `<@${target.id}> is now an **${newRole}** of the party.`, gid)] });
    }

    if (sub === 'disband') {
      const myMembership = db.prepare('SELECT pm.*, p.name FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.guild_id = ? AND pm.user_id = ?').get(gid, uid);
      if (!myMembership || myMembership.role !== 'leader') return interaction.reply({ embeds: [errorEmbed('Only the party leader can disband the party.')], flags: 64 });

      db.prepare('DELETE FROM party_members WHERE party_id = ?').run(myMembership.party_id);
      db.prepare('UPDATE parties SET is_active = 0 WHERE id = ?').run(myMembership.party_id);
      logActivity(gid, 'PARTY_DISBANDED', uid, myMembership.name, '');

      return interaction.reply({ embeds: [successEmbed('Party Disbanded', `**${myMembership.name}** has been dissolved.`, gid)] });
    }
  }
};
