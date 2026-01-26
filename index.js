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
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// ---------------------
// Express Setup for Webhooks
// ---------------------
import express from 'express';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 8080;
app.use(bodyParser.json());

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Leaderboard Function
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, (milk*1.1 + eggs*1.1 + cattle) AS total
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
// Discord Login
// ---------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // refresh every 5 min
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login Discord bot:', err);
});

// ---------------------
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    const payload = req.body;
    console.log('📩 Webhook received!', payload);

    // Example extraction — adjust based on your webhook data
    const username = payload.username || 'Unknown';
    const milkToAdd = Number(payload.milk) || 0;
    const eggsToAdd = Number(payload.eggs) || 0;
    const cattleToAdd = Number(payload.cattle) || 0;

    await pool.query(
      `INSERT INTO ranch_stats (username, milk, eggs, cattle)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
       SET milk = ranch_stats.milk + EXCLUDED.milk,
           eggs = ranch_stats.eggs + EXCLUDED.eggs,
           cattle = ranch_stats.cattle + EXCLUDED.cattle`,
      [username, milkToAdd, eggsToAdd, cattleToAdd]
    );

    console.log(`Stats updated for ${username}`);
    updateLeaderboard(); // Update Discord leaderboard immediately
    res.status(200).send('Webhook processed');
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Error');
  }
});
