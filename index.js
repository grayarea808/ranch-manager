// index.js
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// -------- PostgreSQL Connection --------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test DB connection
try {
  const res = await pool.query('SELECT NOW()');
  console.log('PostgreSQL connected:', res.rows[0]);
} catch (err) {
  console.error('PostgreSQL connection error:', err);
}

// -------- Discord Bot Setup --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  startLeaderboardLoop();
});

client.login(process.env.BOT_TOKEN);

// -------- Leaderboard Logic --------
const LEADERBOARD_CHANNEL_ID = 'YOUR_CHANNEL_ID'; // put your channel ID here
const LEADERBOARD_INTERVAL = 60 * 1000; // 60 seconds

async function startLeaderboardLoop() {
  const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);

  setInterval(async () => {
    try {
      const res = await pool.query(`
        SELECT player_name, milk, eggs, cattle,
               (milk + eggs + cattle) AS total
        FROM ranch_stats
        ORDER BY total DESC
        LIMIT 10
      `);

      if (!res.rows.length) return;

      let leaderboard = `🏆 Baba Yaga Ranch — Page 1/1\n`;
      leaderboard += `📅 Next Ranch Payout: Saturday, Jan 31\n\n`;
      leaderboard += `💰 Ranch Payout\n`;

      res.rows.forEach(player => {
        leaderboard += `${player.player_name}\n`;
        leaderboard += `🥛 Milk: ${player.milk}\n`;
        leaderboard += `🥚 Eggs: ${player.eggs}\n`;
        leaderboard += `🐄 Cattle: ${player.cattle}\n`;
        leaderboard += `💰 Total: $${player.total}\n\n`;
      });

      await channel.send(leaderboard);
      console.log('Leaderboard updated!');
    } catch (err) {
      console.error('Error updating leaderboard:', err);
    }
  }, LEADERBOARD_INTERVAL);
}
