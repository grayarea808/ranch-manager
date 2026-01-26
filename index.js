// ---------------------
// Imports & Setup
// ---------------------
import pkg from 'pg';
import express from 'express';
import bodyParser from 'body-parser';
import { Client, GatewayIntentBits } from 'discord.js';

const { Pool } = pkg;

// ---------------------
// PostgreSQL Setup
// ---------------------
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false }
});

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express Webhook Setup
// ---------------------
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Weekly Reset Setup
// ---------------------
const WEEKLY_RESET_DAY = new Date(); // today
WEEKLY_RESET_DAY.setHours(0, 0, 0, 0);

async function resetWeeklyLeaderboard() {
  try {
    await pool.query(`UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0`);
    console.log('🗑 Weekly leaderboard reset!');
  } catch (err) {
    console.error('Error resetting leaderboard:', err);
  }
}

// ---------------------
// Discord Ready Event
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();

  // Update every 5 minutes
  setInterval(updateLeaderboard, 5 * 60 * 1000);

  // Weekly reset check (every hour)
  setInterval(async () => {
    const now = new Date();
    if (
      now - WEEKLY_RESET_DAY >= 7 * 24 * 60 * 60 * 1000 // 7 days
    ) {
      await resetWeeklyLeaderboard();
      WEEKLY_RESET_DAY.setTime(now.getTime());
      await updateLeaderboard();
    }
  }, 60 * 60 * 1000);
});

// ---------------------
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  const data = req.body;
  console.log('📩 Webhook received!', JSON.stringify(data, null, 2));

  try {
    const username = data.username;

    let milkAdded = 0;
    let eggsAdded = 0;
    let cattleAdded = 0;

    if (data.embeds && data.embeds.length > 0) {
      const desc = data.embeds[0].description;
      const regex = /Added (\w+) .* : (\d+)/i;
      const match = desc.match(regex);

      if (match) {
        const item = match[1].toLowerCase();
        const amount = parseInt(match[2], 10);

        if (item === 'milk') milkAdded = amount;
        if (item === 'eggs') eggsAdded = amount;
        if (item === 'cattle') cattleAdded = amount;
      }
    }

    await pool.query(
      `INSERT INTO ranch_stats (username, milk, eggs, cattle)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
       SET milk = ranch_stats.milk + EXCLUDED.milk,
           eggs = ranch_stats.eggs + EXCLUDED.eggs,
           cattle = ranch_stats.cattle + EXCLUDED.cattle;`,
      [username, milkAdded, eggsAdded, cattleAdded]
    );

    res.status(200).send('OK');
    await updateLeaderboard();
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Error');
  }
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
             milk*1.25 + eggs*1.25 + cattle*1.0 AS total
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
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
