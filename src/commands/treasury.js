import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import db from '../database.js';
import { errorEmbed, ledgerEmbed, successEmbed, logActivity } from '../utils/embeds.js';

function getTreasury(gid) {
  return db.prepare('SELECT * FROM treasury WHERE guild_id = ?').get(gid);
}

function getWallet(gid, uid) {
  const w = db.prepare('SELECT * FROM citizen_wallets WHERE guild_id = ? AND user_id = ?').get(gid, uid);
  if (!w) {
    db.prepare('INSERT OR IGNORE INTO citizen_wallets (guild_id, user_id) VALUES (?, ?)').run(gid, uid);
    return { guild_id: gid, user_id: uid, balance: 0 };
  }
  return w;
}

function recordTx(gid, type, amount, balanceAfter, description, authorizedBy, recipientId = null) {
  db.prepare(`
    INSERT INTO treasury_transactions (guild_id, type, amount, balance_after, description, authorized_by, recipient_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gid, type, amount, balanceAfter, description, authorizedBy, recipientId);
  db.prepare('UPDATE treasury SET balance = ?, last_updated = ? WHERE guild_id = ?')
    .run(balanceAfter, Math.floor(Date.now() / 1000), gid);
}

export default {
  data: new SlashCommandBuilder()
    .setName('treasury')
    .setDescription('Manage the government treasury and citizen wallets')
    // --- Public ---
    .addSubcommand(s => s
      .setName('balance')
      .setDescription('View the government treasury balance'))
    .addSubcommand(s => s
      .setName('wallet')
      .setDescription('View your own or another citizen\'s wallet')
      .addUserOption(o => o.setName('user').setDescription('User to view (defaults to yourself)')))
    .addSubcommand(s => s
      .setName('transactions')
      .setDescription('View recent treasury transactions')
      .addIntegerOption(o => o.setName('limit').setDescription('Number of transactions to show (default 10)').setMinValue(1).setMaxValue(25)))
    // --- Admin ---
    .addSubcommand(s => s
      .setName('configure')
      .setDescription('Configure treasury settings (Admin only)')
      .addStringOption(o => o.setName('currency_name').setDescription('Currency name (e.g. Credits, Dollars, Coins)'))
      .addStringOption(o => o.setName('currency_symbol').setDescription('Currency symbol (e.g. ₡, $, 🪙)'))
      .addIntegerOption(o => o.setName('starting_balance').setDescription('Set the government starting balance').setMinValue(0)))
    .addSubcommand(s => s
      .setName('deposit')
      .setDescription('Add funds to the treasury (Admin only)')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to deposit').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason / description').setRequired(true)))
    .addSubcommand(s => s
      .setName('withdraw')
      .setDescription('Withdraw funds from the treasury (Admin only)')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to withdraw').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason / description').setRequired(true)))
    .addSubcommand(s => s
      .setName('grant')
      .setDescription('Grant treasury funds to a citizen\'s wallet (Admin only)')
      .addUserOption(o => o.setName('citizen').setDescription('Recipient citizen').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to grant').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason for grant').setRequired(true)))
    .addSubcommand(s => s
      .setName('fine')
      .setDescription('Deduct funds from a citizen\'s wallet (Admin only)')
      .addUserOption(o => o.setName('citizen').setDescription('Citizen to fine').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to deduct').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason for fine').setRequired(true)))
    .addSubcommand(s => s
      .setName('pay')
      .setDescription('Pay a citizen from the treasury (Admin only)')
      .addUserOption(o => o.setName('citizen').setDescription('Recipient citizen').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to pay').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason for payment').setRequired(true)))
    .addSubcommand(s => s
      .setName('transfer')
      .setDescription('Transfer between citizen wallets (Admin only)')
      .addUserOption(o => o.setName('from').setDescription('Sender').setRequired(true))
      .addUserOption(o => o.setName('to').setDescription('Recipient').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to transfer').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('Reason').setRequired(true)))
    .addSubcommand(s => s
      .setName('send')
      .setDescription('Send funds from your wallet to another citizen')
      .addUserOption(o => o.setName('to').setDescription('Recipient citizen').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to send').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('description').setDescription('What is this payment for?').setRequired(true)))
    .addSubcommand(s => s
      .setName('richlist')
      .setDescription('View the top citizens by wallet balance')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    // Ensure treasury exists
    db.prepare('INSERT OR IGNORE INTO treasury (guild_id) VALUES (?)').run(gid);
    const treasury = getTreasury(gid);
    const sym = treasury.currency_symbol;
    const cur = treasury.currency_name;

    if (sub === 'balance') {
      const recentTx = db.prepare('SELECT * FROM treasury_transactions WHERE guild_id = ? ORDER BY id DESC LIMIT 5').all(gid);
      const txText = recentTx.length > 0
        ? recentTx.map(t => {
            const sign = ['deposit','fine_collected','tax'].includes(t.type) ? '+' : '-';
            return `${sign}${sym}${t.amount.toLocaleString()} — ${t.description} (<t:${t.created_at}:D>)`;
          }).join('\n')
        : '*No transactions yet.*';

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`${sym} ${cur} — Government Treasury`)
        .addFields(
          { name: 'Current Balance', value: `**${sym}${treasury.balance.toLocaleString()}** ${cur}`, inline: false },
          { name: 'Recent Transactions', value: txText }
        )
        .setFooter({ text: `Last updated` })
        .setTimestamp(treasury.last_updated * 1000);
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (sub === 'wallet') {
      const target = interaction.options.getUser('user') || interaction.user;
      const citizen = db.prepare('SELECT * FROM citizens WHERE guild_id = ? AND user_id = ?').get(gid, target.id);
      const wallet = getWallet(gid, target.id);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${sym} Wallet: ${target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: 'Balance', value: `**${sym}${wallet.balance.toLocaleString()}** ${cur}`, inline: true },
          { name: 'Citizen Status', value: citizen ? `Citizen #${citizen.citizen_number}` : '*Not registered*', inline: true }
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'transactions') {
      const limit = interaction.options.getInteger('limit') || 10;
      const txs = db.prepare('SELECT * FROM treasury_transactions WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(gid, limit);
      if (txs.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📒 Treasury Ledger').setDescription('No transactions recorded yet.')] });

      const typeEmoji = { deposit: '📥', withdrawal: '📤', grant: '🎁', fine_collected: '⚖️', payment: '💸', transfer: '↔️' };
      const lines = txs.map(t => {
        const sign = ['deposit','fine_collected'].includes(t.type) ? `+${sym}` : `-${sym}`;
        return `${typeEmoji[t.type] || '💰'} **${sign}${t.amount.toLocaleString()}** → ${sym}${t.balance_after.toLocaleString()} — ${t.description}${t.recipient_id ? ` (<@${t.recipient_id}>)` : ''} <t:${t.created_at}:D>`;
      });

      return interaction.reply({ embeds: [ledgerEmbed(`📒 Treasury Ledger — Last ${txs.length} Transactions`, lines)] });
    }

    if (sub === 'richlist') {
      const wallets = db.prepare(`
        SELECT cw.user_id, cw.balance, c.citizen_number
        FROM citizen_wallets cw
        LEFT JOIN citizens c ON cw.guild_id = c.guild_id AND cw.user_id = c.user_id
        WHERE cw.guild_id = ? AND cw.balance > 0
        ORDER BY cw.balance DESC LIMIT 10
      `).all(gid);

      if (wallets.length === 0) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('🏆 Richest Citizens').setDescription('No citizen has any funds yet.')] });

      const medals = ['🥇','🥈','🥉'];
      const list = wallets.map((w, i) => `${medals[i] || `**${i+1}.**`} <@${w.user_id}> — ${sym}${w.balance.toLocaleString()}`).join('\n');

      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('🏆 Wealthiest Citizens').setDescription(list)] });
    }

    // --- Admin commands ---
    if (!isAdmin) return interaction.reply({ embeds: [errorEmbed('You need Manage Server permissions.')], flags: 64 });

    if (sub === 'configure') {
      const currencyName = interaction.options.getString('currency_name');
      const currencySymbol = interaction.options.getString('currency_symbol');
      const startingBalance = interaction.options.getInteger('starting_balance');
      const changes = [];

      if (currencyName) { db.prepare('UPDATE treasury SET currency_name = ? WHERE guild_id = ?').run(currencyName, gid); changes.push(`Currency name: **${currencyName}**`); }
      if (currencySymbol) { db.prepare('UPDATE treasury SET currency_symbol = ? WHERE guild_id = ?').run(currencySymbol, gid); changes.push(`Currency symbol: **${currencySymbol}**`); }
      if (startingBalance !== null) {
        db.prepare('UPDATE treasury SET balance = ? WHERE guild_id = ?').run(startingBalance, gid);
        changes.push(`Balance set to: **${startingBalance}**`);
        logActivity(gid, 'TREASURY_CONFIGURED', uid, 'balance', `${startingBalance}`);
      }
      if (changes.length === 0) return interaction.reply({ embeds: [errorEmbed('No changes provided.')], flags: 64 });

      return interaction.reply({ embeds: [successEmbed('Treasury Configured', changes.join('\n'), gid)] });
    }

    if (sub === 'deposit') {
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      const newBalance = treasury.balance + amount;
      db.transaction(() => {
        recordTx(gid, 'deposit', amount, newBalance, desc, uid);
        logActivity(gid, 'TREASURY_DEPOSIT', uid, `${sym}${amount}`, desc);
      })();

      return interaction.reply({ embeds: [successEmbed('Deposit Made',
        `${sym}**${amount.toLocaleString()}** deposited.\n📝 ${desc}\n\n💰 New balance: **${sym}${newBalance.toLocaleString()}**`, gid)] });
    }

    if (sub === 'withdraw') {
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      if (treasury.balance < amount) return interaction.reply({ embeds: [errorEmbed(`Insufficient funds. Treasury has ${sym}${treasury.balance.toLocaleString()}.`)], flags: 64 });
      const newBalance = treasury.balance - amount;
      db.transaction(() => {
        recordTx(gid, 'withdrawal', amount, newBalance, desc, uid);
        logActivity(gid, 'TREASURY_WITHDRAWAL', uid, `${sym}${amount}`, desc);
      })();

      return interaction.reply({ embeds: [successEmbed('Withdrawal Made',
        `${sym}**${amount.toLocaleString()}** withdrawn.\n📝 ${desc}\n\n💰 Remaining balance: **${sym}${newBalance.toLocaleString()}**`, gid)] });
    }

    if (sub === 'grant') {
      const recipient = interaction.options.getUser('citizen');
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      if (treasury.balance < amount) return interaction.reply({ embeds: [errorEmbed(`Insufficient funds. Treasury has ${sym}${treasury.balance.toLocaleString()}.`)], flags: 64 });

      const newBalance = treasury.balance - amount;
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO citizen_wallets (guild_id, user_id) VALUES (?, ?)').run(gid, recipient.id);
        db.prepare('UPDATE citizen_wallets SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, recipient.id);
        recordTx(gid, 'grant', amount, newBalance, desc, uid, recipient.id);
        logActivity(gid, 'TREASURY_GRANT', uid, recipient.id, `${sym}${amount}: ${desc}`);
      })();

      const wallet = getWallet(gid, recipient.id);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🎁 Grant Issued')
        .setDescription(`${sym}**${amount.toLocaleString()}** granted to <@${recipient.id}>`)
        .addFields(
          { name: '📝 Description', value: desc },
          { name: `${sym} Recipient Balance`, value: `${sym}${wallet.balance.toLocaleString()}`, inline: true },
          { name: `${sym} Treasury Balance`, value: `${sym}${newBalance.toLocaleString()}`, inline: true }
        )] });
    }

    if (sub === 'fine') {
      const target = interaction.options.getUser('citizen');
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      const wallet = getWallet(gid, target.id);
      const deducted = Math.min(amount, wallet.balance); // can't go below 0

      // Fines go INTO the treasury
      const newBalance = treasury.balance + deducted;
      db.transaction(() => {
        db.prepare('UPDATE citizen_wallets SET balance = MAX(0, balance - ?) WHERE guild_id = ? AND user_id = ?').run(amount, gid, target.id);
        recordTx(gid, 'fine_collected', deducted, newBalance, `Fine: ${desc}`, uid, target.id);
        logActivity(gid, 'CITIZEN_FINED', uid, target.id, `${sym}${amount}: ${desc}`);
      })();

      const updatedWallet = getWallet(gid, target.id);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚖️ Fine Issued')
        .setDescription(`<@${target.id}> has been fined ${sym}**${deducted.toLocaleString()}**`)
        .addFields(
          { name: '📝 Reason', value: desc },
          { name: `${sym} Citizen Balance`, value: `${sym}${updatedWallet.balance.toLocaleString()}`, inline: true },
          { name: `${sym} Treasury Balance`, value: `${sym}${newBalance.toLocaleString()}`, inline: true }
        )] });
    }

    if (sub === 'pay') {
      const recipient = interaction.options.getUser('citizen');
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      if (treasury.balance < amount) return interaction.reply({ embeds: [errorEmbed(`Insufficient funds. Treasury has ${sym}${treasury.balance.toLocaleString()}.`)], flags: 64 });

      const newBalance = treasury.balance - amount;
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO citizen_wallets (guild_id, user_id) VALUES (?, ?)').run(gid, recipient.id);
        db.prepare('UPDATE citizen_wallets SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, recipient.id);
        recordTx(gid, 'payment', amount, newBalance, desc, uid, recipient.id);
        logActivity(gid, 'TREASURY_PAYMENT', uid, recipient.id, `${sym}${amount}: ${desc}`);
      })();

      const wallet = getWallet(gid, recipient.id);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('💸 Payment Issued')
        .setDescription(`${sym}**${amount.toLocaleString()}** paid to <@${recipient.id}>`)
        .addFields(
          { name: '📝 Description', value: desc },
          { name: `${sym} Recipient Balance`, value: `${sym}${wallet.balance.toLocaleString()}`, inline: true },
          { name: `${sym} Treasury Balance`, value: `${sym}${newBalance.toLocaleString()}`, inline: true }
        )] });
    }

    if (sub === 'transfer') {
      const from = interaction.options.getUser('from');
      const to = interaction.options.getUser('to');
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');
      if (from.id === to.id) return interaction.reply({ embeds: [errorEmbed('Cannot transfer to the same user.')], flags: 64 });

      const fromWallet = getWallet(gid, from.id);
      if (fromWallet.balance < amount) return interaction.reply({ embeds: [errorEmbed(`<@${from.id}> only has ${sym}${fromWallet.balance.toLocaleString()}.`)], flags: 64 });

      db.transaction(() => {
        db.prepare('UPDATE citizen_wallets SET balance = balance - ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, from.id);
        db.prepare('INSERT OR IGNORE INTO citizen_wallets (guild_id, user_id) VALUES (?, ?)').run(gid, to.id);
        db.prepare('UPDATE citizen_wallets SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, to.id);
        logActivity(gid, 'CITIZEN_TRANSFER', uid, `${from.id} → ${to.id}`, `${sym}${amount}: ${desc}`);
      })();

      const fromWalletAfter = getWallet(gid, from.id);
      const toWalletAfter = getWallet(gid, to.id);
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('↔️ Transfer Completed')
        .setDescription(`${sym}**${amount.toLocaleString()}** transferred from <@${from.id}> to <@${to.id}>`)
        .addFields(
          { name: '📝 Description', value: desc },
          { name: `${sym} Sender Balance`, value: `${sym}${fromWalletAfter.balance.toLocaleString()}`, inline: true },
          { name: `${sym} Recipient Balance`, value: `${sym}${toWalletAfter.balance.toLocaleString()}`, inline: true }
        )] });
    }

    if (sub === 'send') {
      const to = interaction.options.getUser('to');
      const amount = interaction.options.getInteger('amount');
      const desc = interaction.options.getString('description');

      if (to.id === uid) return interaction.reply({ embeds: [errorEmbed('You cannot send funds to yourself.')], flags: 64 });
      if (to.bot) return interaction.reply({ embeds: [errorEmbed('You cannot send funds to a bot.')], flags: 64 });

      const senderWallet = getWallet(gid, uid);
      if (senderWallet.balance < amount) {
        return interaction.reply({ embeds: [errorEmbed(`You only have ${sym}${senderWallet.balance.toLocaleString()} in your wallet.`)], flags: 64 });
      }

      db.transaction(() => {
        db.prepare('UPDATE citizen_wallets SET balance = balance - ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, uid);
        db.prepare('INSERT OR IGNORE INTO citizen_wallets (guild_id, user_id) VALUES (?, ?)').run(gid, to.id);
        db.prepare('UPDATE citizen_wallets SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, gid, to.id);
        logActivity(gid, 'CITIZEN_SEND', uid, to.id, `${sym}${amount}: ${desc}`);
      })();

      const senderAfter = getWallet(gid, uid);
      const recipientAfter = getWallet(gid, to.id);

      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('💸 Funds Sent')
        .setDescription(`You sent ${sym}**${amount.toLocaleString()}** to <@${to.id}>`)
        .addFields(
          { name: '📝 Description', value: desc },
          { name: `${sym} Your Balance`, value: `${sym}${senderAfter.balance.toLocaleString()}`, inline: true },
          { name: `${sym} Recipient Balance`, value: `${sym}${recipientAfter.balance.toLocaleString()}`, inline: true }
        )], flags: 64 });
    }
  }
};
