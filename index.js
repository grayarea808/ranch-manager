// index.js

// ---------------------
// PostgreSQL Setup
// ---------------------
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`,
  ssl: { rejectUnauthorized: false } // required for Railway
});

// ---------------------
// Discord Setup
// ---------------------
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Bot Ready
// ---------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  // Update leaderboard every 5 minutes
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    // Example query: top 10 players by total
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, milk * 1.1 + eggs * 1.1 + cattle AS total
      FROM ranch_data
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Baba Yaga Ranch — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${row.total.toFixed(2)}\n\n`;
    });

    // Fetch the channel
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.error('Channel not found!');

    // Edit existing bot message if exists
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
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
