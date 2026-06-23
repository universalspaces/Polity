/**
 * commands/bill.js — Legislation management.
 *
 * Changes from v1:
 *  - Quorum / deadline moved inline onto the bills table (no more bill_voting_config join).
 *  - castBillVote imported from utils/voting — single source of truth shared with bill_vote handler.
 *  - Parliament-role check extracted to a helper.
 *  - Sub-handlers are named inner functions, not long if-chains.
 */

import {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import db                                                from '../database.js';
import { errorEmbed, successEmbed, infoEmbed, listEmbeds, logActivity, replyError, statusField, ts, truncate, now } from '../utils/embeds.js';
import { castBillVote, getBillTally, voteLabel, voteEmoji } from '../utils/voting.js';
import { votingWindowError } from '../utils/governance.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bill')
    .setDescription('Manage legislation in the legislature')
    .addSubcommand(s => s
      .setName('propose')
      .setDescription('Propose a new bill')
      .addStringOption(o => o.setName('title').setDescription('Bill title').setRequired(true))
      .addStringOption(o => o.setName('content').setDescription('Bill content / full text').setRequired(true))
      .addIntegerOption(o => o.setName('voting_hours').setDescription('Auto-reject after this many hours (omit = no deadline)').setMinValue(1).setMaxValue(720))
      .addIntegerOption(o => o.setName('quorum').setDescription('Minimum votes required before the bill can pass or fail').setMinValue(1).setMaxValue(500)))
    .addSubcommand(s => s
      .setName('amend')
      .setDescription('Amend a bill (sponsor or admin only)')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true))
      .addStringOption(o => o.setName('new_content').setDescription('Updated bill text').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for amendment')))
    .addSubcommand(s => s
      .setName('cosponsor')
      .setDescription('Co-sponsor an existing bill')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('vote')
      .setDescription('Vote on a bill (changeable while open)')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true))
      .addStringOption(o => o.setName('vote').setDescription('Your vote').setRequired(true)
        .addChoices(
          { name: '✅ Yea',     value: 'yes' },
          { name: '❌ Nay',     value: 'no' },
          { name: '⬛ Abstain', value: 'abstain' },
        )))
    .addSubcommand(s => s
      .setName('pass')
      .setDescription('Pass a bill into law (admin only)')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('reject')
      .setDescription('Reject a bill (admin only)')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('repeal')
      .setDescription('Repeal an enacted law (admin only)')
      .addIntegerOption(o => o.setName('law_id').setDescription('Law §ID').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for repeal')))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('View bill details')
      .addIntegerOption(o => o.setName('bill_id').setDescription('Bill ID').setRequired(true)))
    .addSubcommand(s => s
      .setName('list')
      .setDescription('List recent bills'))
    .addSubcommand(s => s
      .setName('laws')
      .setDescription('View all enacted laws')),

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const gid    = interaction.guildId;
    const uid    = interaction.user.id;
    const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(gid);

    switch (sub) {
      case 'propose':  return propose(interaction, gid, uid, config);
      case 'amend':    return amend(interaction, gid, uid, config);
      case 'cosponsor':return cosponsor(interaction, gid, uid);
      case 'vote':     return vote(interaction, gid, uid, config);
      case 'pass':     return pass(interaction, gid, uid, config);
      case 'reject':   return reject(interaction, gid, uid);
      case 'repeal':   return repeal(interaction, gid, uid, config);
      case 'info':     return info(interaction, gid);
      case 'list':     return list(interaction, gid);
      case 'laws':     return laws(interaction, gid);
    }
  },
};

// ── Sub-handlers ──────────────────────────────────────────────────────────────

function voteButtons(billId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bill_vote:${billId}:yes`).setLabel('Yea').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bill_vote:${billId}:no`).setLabel('Nay').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`bill_vote:${billId}:abstain`).setLabel('Abstain').setEmoji('⬛').setStyle(ButtonStyle.Secondary),
  );
}

async function propose(interaction, gid, uid, config) {
  const title       = interaction.options.getString('title');
  const content     = interaction.options.getString('content');
  const votingHours = interaction.options.getInteger('voting_hours');
  const quorum      = interaction.options.getInteger('quorum');
  const deadline    = votingHours ? now() + votingHours * 3600 : null;

  const { lastInsertRowid: billId } = db.prepare(
    `INSERT INTO bills (guild_id, title, content, sponsor_id, quorum, voting_deadline) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(gid, title, content, uid, quorum ?? null, deadline);

  db.prepare('INSERT OR IGNORE INTO bill_cosponsors (bill_id, user_id) VALUES (?, ?)').run(billId, uid);
  logActivity(gid, 'BILL_PROPOSED', uid, title);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2).setTimestamp()
    .setTitle(`📜 Bill Proposed: ${title}`)
    .setDescription(truncate(content))
    .addFields(
      { name: '🆔 Bill ID',          value: `#${billId}`,                                           inline: true },
      { name: '👤 Sponsor',           value: `<@${uid}>`,                                            inline: true },
      statusField('proposed', 'Voting is open'),
      { name: '⏰ Voting Deadline',   value: deadline ? ts(deadline) : 'No deadline',                inline: true },
      { name: '🗳️ Quorum',           value: quorum ? `${quorum} votes required` : 'No quorum set',  inline: true },
    )
    .setFooter({ text: `Bill #${billId} · Use the buttons below to vote` });

  const payload = { embeds: [embed], components: [voteButtons(billId)] };

  if (config?.legislature_channel) {
    const ch = await interaction.guild.channels.fetch(config.legislature_channel).catch(() => null);
    if (ch) {
      await ch.send(payload);
      return interaction.reply({ content: `✅ Bill posted in ${ch}.`, flags: 64 });
    }
  }
  return interaction.reply(payload);
}

async function amend(interaction, gid, uid, config) {
  const billId     = interaction.options.getInteger('bill_id');
  const newContent = interaction.options.getString('new_content');
  const reason     = interaction.options.getString('reason') ?? 'No reason provided.';
  const bill       = db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?').get(billId, gid);

  if (!bill)                      return replyError(interaction, `Bill #${billId} not found.`);
  if (bill.status !== 'proposed') return replyError(interaction, 'Only proposed bills can be amended.');
  if (bill.sponsor_id !== uid && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, 'Only the bill sponsor or an admin can amend a bill.');
  }

  // Reset all votes — the bill text has changed
  db.prepare('DELETE FROM bill_votes WHERE bill_id = ?').run(billId);
  db.prepare('UPDATE bills SET content = ?, votes_yes = 0, votes_no = 0, votes_abstain = 0 WHERE id = ?').run(newContent, billId);
  logActivity(gid, 'BILL_AMENDED', uid, bill.title, reason);

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C).setTimestamp()
    .setTitle(`📝 Bill Amended: ${bill.title}`)
    .setDescription(truncate(newContent, 900))
    .addFields(
      { name: '📝 Reason', value: reason },
      { name: '⚠️ Note',   value: 'All previous votes have been reset due to this amendment.' },
    );

  if (config?.legislature_channel) {
    const ch = await interaction.guild.channels.fetch(config.legislature_channel).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  }
  return interaction.reply({ embeds: [embed] });
}

async function cosponsor(interaction, gid, uid) {
  const billId = interaction.options.getInteger('bill_id');
  const bill   = db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?').get(billId, gid);
  if (!bill)                      return replyError(interaction, `Bill #${billId} not found.`);
  if (bill.status !== 'proposed') return replyError(interaction, 'You can only co-sponsor bills still under consideration.');
  if (bill.sponsor_id === uid)    return replyError(interaction, 'You are already the primary sponsor.');

  try {
    db.prepare('INSERT INTO bill_cosponsors (bill_id, user_id) VALUES (?, ?)').run(billId, uid);
  } catch {
    return replyError(interaction, 'You have already co-sponsored this bill.');
  }

  const coCount = db.prepare('SELECT COUNT(*) as c FROM bill_cosponsors WHERE bill_id = ?').get(billId).c;
  logActivity(gid, 'BILL_COSPONSORED', uid, bill.title);
  return interaction.reply({
    embeds: [successEmbed('Bill Co-sponsored', `You co-sponsored **${bill.title}**.\n📜 This bill now has **${coCount}** co-sponsor(s).`)],
    flags: 64,
  });
}

async function vote(interaction, gid, uid, config) {
  const billId = interaction.options.getInteger('bill_id');
  const v      = interaction.options.getString('vote');

  // Parliament role check
  if (config?.parliament_role) {
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    if (!member?.roles.cache.has(config.parliament_role)) {
      return replyError(interaction, `Only members of <@&${config.parliament_role}> can vote on bills.`);
    }
  }

  const result = castBillVote(gid, billId, uid, v);
  if (!result.ok) return replyError(interaction, result.reason);

  const bill     = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  const total    = bill.votes_yes + bill.votes_no + bill.votes_abstain;
  const desc     = result.changed
    ? `Changed from **${voteLabel(result.previous)}** to **${voteLabel(v)}** on Bill #${billId}: **${bill.title}**`
    : `You voted **${voteLabel(v)}** on Bill #${billId}: **${bill.title}**`;

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

async function pass(interaction, gid, uid, config) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, 'You need **Manage Server** permission.');
  }
  const billId = interaction.options.getInteger('bill_id');
  const bill   = db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?').get(billId, gid);
  if (!bill)                      return replyError(interaction, `Bill #${billId} not found.`);
  if (bill.status !== 'proposed') return replyError(interaction, 'This bill is not in a proposed state.');
  if (votingWindowError(bill) === 'expired') return replyError(interaction, 'The voting deadline has passed; this bill can no longer be passed.');
  const tally = getBillTally(billId);
  const total = tally.yes + tally.no + tally.abstain;

  if (bill.quorum) {
    if (total < bill.quorum) {
      return replyError(interaction, `Quorum not met. Requires **${bill.quorum}** votes — only **${total}** cast so far.`);
    }
  }

  if (tally.yes <= tally.no) {
    return replyError(interaction, 'This bill does not have more Yea than Nay votes.');
  }

  const timestamp = now();
  const committed = db.transaction(() => {
    const updated = db.prepare(`UPDATE bills SET status = 'passed', voted_at = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'proposed'`)
      .run(timestamp, tally.yes, tally.no, tally.abstain, billId);
    if (updated.changes !== 1) return false;
    db.prepare('INSERT INTO laws (guild_id, title, content, bill_id, enacted_by, enacted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(gid, bill.title, bill.content, billId, uid, timestamp);
    logActivity(gid, 'BILL_PASSED', uid, bill.title);
    return true;
  })();
  if (!committed) return replyError(interaction, 'This bill was already finalized.');

  const cosponsors = db.prepare('SELECT * FROM bill_cosponsors WHERE bill_id = ?').all(billId);
  const coText     = cosponsors.map(c => `<@${c.user_id}>`).join(', ') || 'None';

  const embed = new EmbedBuilder()
    .setColor(0x57F287).setTimestamp()
    .setTitle(`✅ Bill Passed Into Law: ${bill.title}`)
    .setDescription(truncate(bill.content, 800))
    .addFields(
      { name: '✅ Yea',      value: `${tally.yes}`,     inline: true },
      { name: '❌ Nay',      value: `${tally.no}`,      inline: true },
      { name: '⬛ Abstain',  value: `${tally.abstain}`, inline: true },
      { name: '👥 Co-sponsors', value: coText },
      { name: '👤 Enacted by',  value: `<@${uid}>`,          inline: true },
    );

  if (config?.legislature_channel) {
    const ch = await interaction.guild.channels.fetch(config.legislature_channel).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  }
  return interaction.reply({ embeds: [embed] });
}

async function reject(interaction, gid, uid) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, 'You need **Manage Server** permission.');
  }
  const billId = interaction.options.getInteger('bill_id');
  const bill   = db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?').get(billId, gid);
  if (!bill)                      return replyError(interaction, `Bill #${billId} not found.`);
  if (bill.status !== 'proposed') return replyError(interaction, 'This bill is not in a proposed state.');
  const tally = getBillTally(billId);
  const total = tally.yes + tally.no + tally.abstain;

  if (bill.quorum) {
    if (total < bill.quorum) {
      return replyError(interaction, `Quorum not met (${total}/${bill.quorum}). Cannot finalize yet.`);
    }
  }

  const committed = db.transaction(() => {
    const updated = db.prepare(`UPDATE bills SET status = 'rejected', voted_at = ?, votes_yes = ?, votes_no = ?, votes_abstain = ? WHERE id = ? AND status = 'proposed'`)
      .run(now(), tally.yes, tally.no, tally.abstain, billId);
    if (updated.changes !== 1) return false;
    logActivity(gid, 'BILL_REJECTED', uid, bill.title);
    return true;
  })();
  if (!committed) return replyError(interaction, 'This bill was already finalized.');
  return interaction.reply({ embeds: [successEmbed('Bill Rejected', `Bill **#${billId} — ${bill.title}** has been rejected.`)] });
}

async function repeal(interaction, gid, uid, config) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, 'You need **Manage Server** permission.');
  }
  const lawId = interaction.options.getInteger('law_id');
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  const law   = db.prepare('SELECT * FROM laws WHERE id = ? AND guild_id = ? AND is_active = 1').get(lawId, gid);
  if (!law) return replyError(interaction, `Law §${lawId} not found or already repealed.`);

  db.transaction(() => {
    db.prepare('UPDATE laws SET is_active = 0 WHERE id = ?').run(lawId);
    logActivity(gid, 'LAW_REPEALED', uid, law.title, reason);
  })();

  const embed = new EmbedBuilder()
    .setColor(0xED4245).setTimestamp()
    .setTitle(`🗑️ Law Repealed: §${lawId} — ${law.title}`)
    .addFields(
      { name: '📝 Reason',     value: reason },
      { name: '👤 Repealed by', value: `<@${uid}>`, inline: true },
    );

  if (config?.legislature_channel) {
    const ch = await interaction.guild.channels.fetch(config.legislature_channel).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  }
  return interaction.reply({ embeds: [embed] });
}

async function info(interaction, gid) {
  const billId = interaction.options.getInteger('bill_id');
  const bill   = db.prepare('SELECT * FROM bills WHERE id = ? AND guild_id = ?').get(billId, gid);
  if (!bill) return replyError(interaction, `Bill #${billId} not found.`);

  const cosponsors  = db.prepare('SELECT * FROM bill_cosponsors WHERE bill_id = ?').all(billId);
  const coText      = cosponsors.filter(c => c.user_id !== bill.sponsor_id).map(c => `<@${c.user_id}>`).join(', ') || 'None';
  const total       = bill.votes_yes + bill.votes_no + bill.votes_abstain;
  const quorumMet   = !bill.quorum || total >= bill.quorum;
  const quorumText  = bill.quorum
    ? `${total}/${bill.quorum} ${quorumMet ? '✅ Met' : '⏳ Not yet met'}`
    : 'No quorum set';
  const statusColor = { proposed: 0x5865F2, passed: 0x57F287, rejected: 0xED4245 };

  const embed = new EmbedBuilder()
    .setColor(statusColor[bill.status] ?? 0x2B2D31).setTimestamp()
    .setTitle(`📜 Bill #${billId}: ${bill.title}`)
    .setDescription(truncate(bill.content, 900))
    .addFields(
      statusField(bill.status, bill.status === 'proposed' ? 'Voting is open' : 'Finalized'),
      { name: '👤 Sponsor',          value: `<@${bill.sponsor_id}>`,                                        inline: true },
      { name: '📅 Proposed',         value: ts(bill.proposed_at, 'D'),                                      inline: true },
      { name: '✅ Yea',              value: `${bill.votes_yes}`,                                            inline: true },
      { name: '❌ Nay',              value: `${bill.votes_no}`,                                             inline: true },
      { name: '⬛ Abstain',          value: `${bill.votes_abstain} / ${total} total`,                       inline: true },
      { name: '🗳️ Quorum',          value: quorumText,                                                     inline: true },
      { name: '⏰ Voting Deadline',  value: bill.voting_deadline ? ts(bill.voting_deadline) : 'No deadline', inline: true },
      { name: '👥 Co-sponsors',      value: coText },
    );

  if (bill.status === 'proposed') {
    return interaction.reply({ embeds: [embed], components: [voteButtons(billId)] });
  }
  return interaction.reply({ embeds: [embed] });
}

async function list(interaction, gid) {
  const bills = db.prepare(`
    SELECT b.*, COUNT(bc.user_id) as cosponsor_count
    FROM bills b
    LEFT JOIN bill_cosponsors bc ON b.id = bc.bill_id
    WHERE b.guild_id = ?
    GROUP BY b.id
    ORDER BY b.id DESC
    LIMIT 20
  `).all(gid);

  if (!bills.length) {
    return interaction.reply({ embeds: [infoEmbed('📜 Bills', 'No bills have been proposed yet.')] });
  }

  const emoji  = { proposed: '🟡', passed: '🟢', rejected: '🔴' };
  const lines = bills.map(b =>
    `${emoji[b.status] ?? '⚪'} **#${b.id}** — ${b.title} *(${b.cosponsor_count} co-sponsor${b.cosponsor_count !== 1 ? 's' : ''})*`
  );

  return interaction.reply({ embeds: listEmbeds('📜 Legislature — Bills', lines) });
}

async function laws(interaction, gid) {
  const enacted = db.prepare("SELECT * FROM laws WHERE guild_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 20").all(gid);
  if (!enacted.length) {
    return interaction.reply({ embeds: [infoEmbed('📖 Laws', 'No laws have been enacted yet.')] });
  }
  const lines = enacted.map(l => `**§${l.id}** — ${l.title} *(enacted ${ts(l.enacted_at, 'D')})*`);
  return interaction.reply({ embeds: listEmbeds('📖 Enacted Laws', lines, { color: 0x57F287 }) });
}
