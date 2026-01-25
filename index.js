// ---------------------
// PostgreSQL Setup
// ---------------------
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false } // Railway requires this
});

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const CLIENT_ID = process.env.CLIENT_ID; // your bot's client ID
const GUILD_ID = process.env.GUILD_ID; // your test server ID

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Deploy slash command
  const commands = [
    new SlashCommandBuilder()
      .setName('addstats')
      .setDescription('Add milk, eggs, and cattle for a user')
      .addStringOption(option => option.setName('username').setDescription('User name').setRequired(true))
      .addIntegerOption(option => option.setName('milk').setDescription('Milk amount').setRequired(false))
      .addIntegerOption(option => option.setName('eggs').setDescription('Eggs amount').setRequired(false))
      .addIntegerOption(option => option.setName('cattle').setDescription('Cattle amount').setRequired(false))
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash command deployed');

  // Initial leaderboard update + interval
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

// ---------------------
// Upsert Function
// ---------------------
async function upsertRanchStats(username, milk = 0, eggs = 0, cattle = 0) {
  try {
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) 
      DO UPDATE SET 
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle;
    `, [username, milk, eggs, cattle]);

    console.log(`✅ Stats updated for ${username}`);
  } catch (err) {
    console.error('🚨 Error updating stats:', err);
  }
}

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk*1.1 + eggs*1.1 + cattle AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${row.total.toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.error('Channel not found!');

    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id);
    if (botMessage) {
      await botMessage.edit(leaderboardMessage);
    } else {
      await channel.send(leaderboardMessage);
    }

    console.log('Leaderboard updated successfully!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Handle Slash Commands
// ---------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'addstats') {
    const username = interaction.options.getString('username');
    const milk = interaction.options.getInteger('milk') || 0;
    const eggs = interaction.options.getInteger('eggs') || 0;
    const cattle = interaction.options.getInteger('cattle') || 0;

    await upsertRanchStats(username, milk, eggs, cattle);
    await updateLeaderboard();

    await interaction.reply(`✅ Stats updated for ${username}: Milk ${milk}, Eggs ${eggs}, Cattle ${cattle}`);
  }
});

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
