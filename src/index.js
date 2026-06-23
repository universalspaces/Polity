/**
 * index.js — Polity entry point.
 *
 * Responsibilities:
 *  - Boot the Discord client
 *  - Load all slash commands from src/commands/
 *  - Register (deploy) them to Discord on ready
 *  - Route interactions to commands and button/select handlers
 *  - Enforce the citizenship gate
 *  - Start the maintenance cron and DB maintenance loop
 */

import {
  Client, GatewayIntentBits, Collection, REST, Routes,
  EmbedBuilder,
} from 'discord.js';
import { readdirSync }          from 'fs';
import path                     from 'path';
import { fileURLToPath }        from 'url';
import dotenv                   from 'dotenv';
import cron                     from 'node-cron';

import db, { ensureGuild, startMaintenance } from './database.js';
import { tick }                              from './utils/scheduler.js';
import { Colors, makeEmbed }                 from './utils/embeds.js';

const HANDLER_LOADERS = {
  bill_vote:  () => import('./handlers/bill_vote.js'),
  imp_vote:   () => import('./handlers/imp_vote.js'),
  party_join: () => import('./handlers/party_join.js'),
  poll_vote:  () => import('./handlers/poll_vote.js'),
  ref_vote:   () => import('./handlers/ref_vote.js'),
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ── Client ─────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands = new Collection();

// ── Load commands ──────────────────────────────────────────────────────────

const commandsPath = path.join(__dirname, 'commands');
for (const file of readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const { default: command } = await import(`./commands/${file}`);
  if (command?.data && command?.execute) {
    client.commands.set(command.data.name, command);
  }
}

// ── Ready ──────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Polity online as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} server(s)`);

  // Deploy slash commands
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const body = client.commands.map(c => c.data.toJSON());
    const applicationId = client.application?.id;

    if (!applicationId) {
      throw new Error('Unable to determine Discord application ID from the logged-in bot token.');
    }

    if (process.env.APPLICATION_ID && process.env.APPLICATION_ID !== applicationId) {
      console.warn(
        `⚠️ APPLICATION_ID (${process.env.APPLICATION_ID}) does not match the logged-in application (${applicationId}); using the token-derived application ID.`,
      );
    }

    console.log(`⏳ Refreshing ${body.length} application (/) commands for application ${applicationId}…`);
    await rest.put(Routes.applicationCommands(applicationId), { body });
    console.log('✅ Commands deployed.');
  } catch (err) {
    console.error('❌ Command deployment failed:', err);
  }

  startMaintenance();
  cron.schedule('* * * * *', () => tick(client).catch(console.error));
  console.log('🚀 Startup complete.');
  console.log('successfully finished startup');
});

// ── Interaction router ─────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.guildId) {
    if (interaction.isRepliable()) {
      return interaction.reply({
        content: '❌ Polity commands can only be used inside a server.',
        flags: 64,
      });
    }
    return;
  }

  // Always ensure guild rows exist
  ensureGuild(interaction.guildId);

  // ── Autocomplete ──────────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try { await cmd.autocomplete(interaction); } catch (err) { console.warn(`[AUTOCOMPLETE ${interaction.commandName}]`, err); }
    }
    return;
  }

  // ── Modals ────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    return routeModal(interaction);
  }

  // ── Buttons ───────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    return routeHandler(interaction);
  }

  // ── Select menus ──────────────────────────────────────────────────────────
  if (
    interaction.isStringSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isRoleSelectMenu()
  ) {
    return routeHandler(interaction);
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  // Citizenship gate
  const config = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(interaction.guildId);
  if (await blockIfCitizenshipRequired(interaction, config)) return;

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[CMD ${interaction.commandName}]`, err);
    const msg = { content: '❌ An error occurred executing that command.', flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ── Handler routing ────────────────────────────────────────────────────────

async function routeHandler(interaction) {
  const customId = interaction.customId;
  const config   = db.prepare('SELECT * FROM server_config WHERE guild_id = ?').get(interaction.guildId);

  // Setup wizard buttons/selects: customId = "setup_<action>[_<sub>]"
  // Route to the setup command's own handle() export instead of handlers/
  if (customId.startsWith('setup_')) {
    try {
      const { handle } = await import('./commands/setup.js');
      // parts = everything after the "setup_" prefix, split by "_"
      // e.g. "setup_channels_set_election" → parts = ['channels', 'set', 'election']
      // We pass the full suffix as a single string so handle() can parse it naturally
      const suffix = customId.slice('setup_'.length); // e.g. "channels_set_election"
      await handle(interaction, [suffix], config);
    } catch (err) {
      console.error('[SETUP HANDLER]', err);
      const msg = { content: '❌ Setup error.', flags: 64 };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  // All other handlers: customId = "<action>:<arg1>:<arg2>…"
  const [action, ...parts] = customId.split(':');
  const loadHandler = HANDLER_LOADERS[action];
  if (!loadHandler) return;

  if (await blockIfCitizenshipRequired(interaction, config)) return;

  try {
    const { handle } = await loadHandler();
    await handle(interaction, parts, config);
  } catch (err) {
    console.error(`[HANDLER ${action}]`, err);
    const msg = { content: '❌ An error occurred.', flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
}

// ── Modal routing ──────────────────────────────────────────────────────────

async function routeModal(interaction) {
  const id = interaction.customId;

  // Setup wizard modals
  if (id.startsWith('setup_')) {
    try {
      const { handleModal } = await import('./commands/setup.js');
      await handleModal(interaction);
    } catch (err) {
      console.error('[SETUP MODAL]', err);
    }
    return;
  }

  // Future modal handlers can be added to HANDLER_LOADERS and routed here.
  const [action, ...parts] = id.split(':');
  const loadHandler = HANDLER_LOADERS[action];
  if (!loadHandler) return;

  try {
    const { handle } = await loadHandler();
    await handle(interaction, parts, null);
  } catch (err) {
    console.error(`[MODAL HANDLER ${action}]`, err);
  }
}

// ── Citizenship exemption list ─────────────────────────────────────────────

const EXEMPT_COMMANDS = new Set(['citizen', 'help', 'setup', 'government', 'admin', 'stats', 'treasury']);
const EXEMPT_SUBS     = new Set(['register', 'profile', 'list', 'info', 'balance', 'wallet', 'transactions', 'richlist', 'judges', 'view', 'docket']);

function citizenshipExempt(interaction) {
  if (interaction.isChatInputCommand?.() && EXEMPT_COMMANDS.has(interaction.commandName)) return true;
  const sub = interaction.options?.getSubcommand?.(false);
  return sub && EXEMPT_SUBS.has(sub);
}

async function blockIfCitizenshipRequired(interaction, config) {
  if (!config?.require_citizenship || citizenshipExempt(interaction)) return false;

  const isCitizen = db.prepare('SELECT 1 FROM citizens WHERE guild_id = ? AND user_id = ?')
    .get(interaction.guildId, interaction.user.id);
  if (isCitizen) return false;

  const msg = {
    embeds: [makeEmbed(Colors.danger)
      .setTitle('❌ Citizenship Required')
      .setDescription(
        `**${config.government_name || 'This government'}** requires you to register as a citizen first.

Use \`/citizen register\` to get started.`
      )],
    flags: 64,
  };

  if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
  else await interaction.reply(msg).catch(() => {});
  return true;
}

// ── Boot ───────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
export default client;
