import { SlashCommandBuilder } from 'discord.js';
import { Colors, makeEmbed } from '../utils/embeds.js';
import { safeField } from '../utils/presentation.js';

const SECTIONS = [
  ['⚙️ Setup', '`/setup` — Interactive server configuration\n`/setup view` — Review the current configuration'],
  ['🗳️ Elections', '`/election create|register|withdraw`\n`/election list|info|open|close|cancel`\n`/vote` — FPTP or ranked-choice ballot'],
  ['📊 Polls & Referendums', '`/poll create|vote|info|list|close|voters`\n`/referendum create|vote|info|list|close`'],
  ['📣 Citizen Action', '`/initiative propose|sign|info|list|withdraw`\n`/recall file|sign|info|list|trigger|withdraw`'],
  ['⚖️ Accountability', '`/impeach file|vote|conclude|info|list`\n`/court` — Judges, cases, rulings, and appeals'],
  ['🏛️ Parties & Offices', '`/party create|join|leave|info|list|members|promote|transfer|disband`\n`/office create|appoint|remove|delete|info|list`'],
  ['📜 Legislature', '`/bill propose|amend|cosponsor|vote|pass|reject|repeal`\n`/bill info|list|laws`'],
  ['💰 Treasury', '`/treasury balance|wallet|transactions|richlist|send`\nAdmin: `configure|deposit|withdraw|grant|fine|pay|transfer`'],
  ['📖 Constitution', '`/constitution add|view|repeal`'],
  ['🪪 Citizens', '`/citizen register|profile|list`'],
  ['📋 Terms & Records', '`/termlimit set|remove|list|check`\n`/remind set|cancel|list`'],
  ['📊 Analytics', '`/government` — Live overview\n`/stats turnout|member|legislature|parties`'],
  ['🔧 Administration', '`/admin auditlog|announce|server_stats`\nModeration, forced closures, reputation, and cleanup tools'],
];

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('View Polity commands by category'),

  async execute(interaction) {
    const pageSize = 4;
    const total = Math.ceil(SECTIONS.length / pageSize);
    const embeds = [];
    for (let page = 0; page < total; page += 1) {
      const embed = makeEmbed(Colors.primary)
        .setTitle(page === 0 ? '🏛️ Polity Command Guide' : `Polity Guide · ${page + 1}/${total}`)
        .setDescription(page === 0
          ? 'Commands are grouped by purpose. Use Discord’s command picker for complete option descriptions.'
          : 'Continued command categories.')
        .addFields(...SECTIONS.slice(page * pageSize, (page + 1) * pageSize).map(([name, value]) => safeField(name, value)))
        .setFooter({ text: `Page ${page + 1}/${total} · /government for a live overview` });
      embeds.push(embed);
    }
    return interaction.reply({ embeds, flags: 64 });
  },
};
