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
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';

const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Weekly Reset Setup
// ---------------------
async function resetLeaderboardIfNeeded() {
  const result = await pool.query(`SELECT last_reset FROM leaderboard_reset LIMIT 1`);
  const now = new Date();

  if (!result.rows[0]) {
    await pool.query(`INSERT INTO leaderboard_reset(last_reset) VALUES($1)`, [now]);
    return;
  }

  const lastReset = new Date(result.rows[0].last_reset);
  const diffDays = Math.floor((now - lastReset) / (1000 * 60 * 60 * 24));

  if (diffDays >= 7) {
    await pool.query(`UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0`);
    await pool.query(`UPDATE leaderboard_reset SET last_reset = $1`, [now]);
    console.log('Leaderboard reset for new week!');
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
        (milk * 1.25 + eggs * 1.25 + cattle * 160) AS total
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
      leaderboardMessage += `💰 Total: $${Number(row.total).toFixed(2)}\n\n`;
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
  const data = req.body;
  console.log('📩 Webhook received!', data);

  try {
    // Example payload parsing
    // Adjust this mapping depending on your game's webhook
    const username = data.username || 'Unknown';
    let milk = 0, eggs = 0, cattle = 0;

    if (data.embeds?.length) {
      const desc = data.embeds[0].description || '';
      const milkMatch = desc.match(/Added Milk.*?: (\d+)/);
      const eggsMatch = desc.match(/Added Eggs.*?: (\d+)/);
      const cattleMatch = desc.match(/Added Cattle.*?: (\d+)/);

      if (milkMatch) milk = parseInt(milkMatch[1]);
      if (eggsMatch) eggs = parseInt(eggsMatch[1]);
      if (cattleMatch) cattle = parseInt(cattleMatch[1]);
    }

    // Upsert into ranch_stats
    await pool.query(`
      INSERT INTO ranch_stats(username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milk, eggs, cattle]);

    await updateLeaderboard();
    res.status(200).send('Webhook processed');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error processing webhook');
  }
});

// ---------------------
// Start Servers
// ---------------------
app.listen(8080, () => {
  console.log('Webhook server listening on port 8080');
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 minutes
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
