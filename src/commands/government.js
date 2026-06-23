import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import db, { ensureGuild } from '../database.js';
import { ts } from '../utils/embeds.js';

// Single aggregated query — one round-trip instead of 14 separate COUNTs.
const stmtCounts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM citizens    WHERE guild_id = @g)                               AS citizens,
    (SELECT COUNT(*) FROM parties     WHERE guild_id = @g AND is_active = 1)             AS parties,
    (SELECT COUNT(*) FROM laws        WHERE guild_id = @g AND is_active = 1)             AS laws,
    (SELECT COUNT(*) FROM elections   WHERE guild_id = @g AND status = 'active')         AS active_elections,
    (SELECT COUNT(*) FROM elections   WHERE guild_id = @g AND status = 'scheduled')      AS scheduled_elections,
    (SELECT COUNT(*) FROM cases       WHERE guild_id = @g AND status != 'closed')        AS open_cases,
    (SELECT COUNT(*) FROM bills       WHERE guild_id = @g AND status = 'proposed')       AS pending_bills,
    (SELECT COUNT(*) FROM offices     WHERE guild_id = @g)                               AS total_offices,
    (SELECT COUNT(*) FROM offices     WHERE guild_id = @g AND holder_id IS NOT NULL)     AS filled_offices,
    (SELECT COUNT(*) FROM referendums WHERE guild_id = @g AND status = 'active')         AS active_refs,
    (SELECT COUNT(*) FROM initiatives WHERE guild_id = @g AND status = 'collecting')     AS active_inits,
    (SELECT COUNT(*) FROM impeachments WHERE guild_id = @g AND status = 'trial')         AS active_impeach,
    (SELECT COUNT(*) FROM polls       WHERE guild_id = @g AND status = 'active')         AS active_polls,
    (SELECT COUNT(*) FROM recalls     WHERE guild_id = @g AND status IN ('collecting','qualified')) AS active_recalls
`);

export default {
  data: new SlashCommandBuilder()
    .setName('government')
    .setDescription('View government statistics and overview'),

  async execute(interaction) {
    const gid      = interaction.guildId;
    ensureGuild(gid);
    const config   = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);
    const treasury = db.prepare('SELECT * FROM treasury WHERE guild_id = ?').get(gid);
    const c        = stmtCounts.get({ g: gid });

    const offices    = db.prepare('SELECT name, holder_id FROM offices WHERE guild_id = ? AND holder_id IS NOT NULL ORDER BY name ASC LIMIT 6').all(gid);
    const officeText = offices.length ? offices.map(o => `**${o.name}:** <@${o.holder_id}>`).join('\n') : '*No positions filled.*';

    const electionParts = [];
    if (c.active_elections)    electionParts.push(`🟢 ${c.active_elections} active`);
    if (c.scheduled_elections) electionParts.push(`📅 ${c.scheduled_elections} scheduled`);

    const civicParts = [
      c.active_refs    && `📊 ${c.active_refs} referendum${c.active_refs !== 1 ? 's' : ''}`,
      c.active_inits   && `📣 ${c.active_inits} initiative${c.active_inits !== 1 ? 's' : ''}`,
      c.active_impeach && `⚖️ ${c.active_impeach} impeachment${c.active_impeach !== 1 ? 's' : ''}`,
      c.active_polls   && `📋 ${c.active_polls} poll${c.active_polls !== 1 ? 's' : ''}`,
      c.active_recalls && `🔄 ${c.active_recalls} recall${c.active_recalls !== 1 ? 's' : ''}`,
    ].filter(Boolean);

    const sym = treasury?.currency_symbol ?? '₡';
    const bal = treasury?.balance ?? 0;
    const cur = treasury?.currency_name  ?? 'Credits';

    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2).setTimestamp()
        .setTitle(`🏛️ ${config?.government_name ?? 'The Republic'} — Government Overview`)
        .setDescription(`*Official government dashboard of **${config?.government_name ?? 'The Republic'}**.*`)
        .addFields(
          { name: '👥 Citizens',         value: `${c.citizens}`,                                      inline: true },
          { name: '🏛️ Parties',         value: `${c.parties}`,                                       inline: true },
          { name: '📜 Laws Enacted',     value: `${c.laws}`,                                          inline: true },
          { name: '🗳️ Elections',        value: electionParts.join(' · ') || '—',                    inline: true },
          { name: '⚖️ Open Cases',       value: `${c.open_cases}`,                                    inline: true },
          { name: '📋 Pending Bills',    value: `${c.pending_bills}`,                                 inline: true },
          { name: '💼 Offices Filled',   value: `${c.filled_offices}/${c.total_offices}`,             inline: true },
          { name: `${sym} Treasury`,     value: `${sym}${bal.toLocaleString()} ${cur}`,               inline: true },
          { name: '🗳️ Civic Activity',  value: civicParts.join(' · ') || '—',                       inline: true },
          { name: '⚡ Current Officials', value: officeText },
        )
        .setFooter({ text: 'Polity • Government System' }),
    ]});
  },
};
