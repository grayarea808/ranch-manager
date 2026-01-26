// ---------------------
// Load Environment Variables
// ---------------------
import 'dotenv/config';

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
  ssl: { rejectUnauthorized: false }, // Railway requires this
});

// ---------------------
// Express Setup for Webhook
// ---------------------
import express from 'express';
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ---------------------
// Discord Setup
// ---------------------
import { Client, GatewayIntentBits } from 'discord.js';
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Weekly Leaderboard Reset Setup
// ---------------------
async function resetLeaderboardIfNeeded() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_reset (
        last_reset TIMESTAMP
      );
    `);

    const { rows } = await pool.query(`SELECT * FROM leaderboard_reset LIMIT 1`);
    const now = new Date();

    if (!rows.length) {
      await pool.query(`INSERT INTO leaderboard_reset (last_reset) VALUES ($1)`, [now]);
      return;
    }

    const lastReset = new Date(rows[0].last_reset);
    const diffDays = (now - lastReset) / (1000 * 60 * 60 * 24);

    if (diffDays >= 7) {
      await pool.query(`UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0`);
      await pool.query(`UPDATE leaderboard_reset SET last_reset = $1`, [now]);
      console.log('Leaderboard reset for new week!');
    }
  } catch (err) {
    console.error('Error resetting leaderboard:', err);
  }
}

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    await resetLeaderboardIfNeeded();

    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
        (milk*1.25 + eggs*1.25 + cattle*160) AS total
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

    console.log('Leaderboard updated!');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// ---------------------
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;
    console.log('📩 Webhook received!', JSON.stringify(data, null, 2));

    const username = data.username;
    const embed = data.embeds?.[0];
    if (!embed) return res.status(400).send('No embed found');

    let milkAdd = 0, eggsAdd = 0, cattleAdd = 0;

    if (embed.title.includes('Milk')) {
      milkAdd = Number(embed.description.match(/\d+$/)?.[0] || 0);
    }
    if (embed.title.includes('Eggs')) {
      eggsAdd = Number(embed.description.match(/\d+$/)?.[0] || 0);
    }
    if (embed.title.includes('Cattle')) {
      cattleAdd = Number(embed.description.match(/\d+$/)?.[0] || 0);
    }

    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + $2,
        eggs = ranch_stats.eggs + $3,
        cattle = ranch_stats.cattle + $4
    `, [username, milkAdd, eggsAdd, cattleAdd]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 min
});

// ---------------------
// Start Server & Login Discord
// ---------------------
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord login failed', err));
