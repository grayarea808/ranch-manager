// ---------------------
// Dependencies
// ---------------------
import express from 'express';
import pkg from 'pg';
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
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Express Webhook Server
// ---------------------
const app = express();
app.use(express.json());
const PORT = 8080;

app.post('/webhook/ranch', async (req, res) => {
  console.log('📩 Webhook received!', req.body);

  try {
    const username = req.body.username;
    const description = req.body.embeds?.[0]?.description || '';

    // Parse added milk, eggs, cattle from description (adjust based on your payload)
    const milkMatch = description.match(/Added Milk .*?: (\d+)/i);
    const eggsMatch = description.match(/Added Eggs .*?: (\d+)/i);
    const cattleMatch = description.match(/Added Cattle .*?: (\d+)/i);

    const milk = milkMatch ? parseInt(milkMatch[1]) : 0;
    const eggs = eggsMatch ? parseInt(eggsMatch[1]) : 0;
    const cattle = cattleMatch ? parseInt(cattleMatch[1]) : 0;

    // Upsert user stats
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET
        milk = ranch_stats.milk + $2,
        eggs = ranch_stats.eggs + $3,
        cattle = ranch_stats.cattle + $4;
    `, [username, milk, eggs, cattle]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // Update every 5 min
  scheduleWeeklyReset();
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
        (milk*1.25 + eggs*1.25 + cattle*200*0.2)::numeric AS total
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
      leaderboardMessage += `💰 Total: $${parseFloat(row.total).toFixed(2)}\n\n`;
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
// Weekly Reset
// ---------------------
function scheduleWeeklyReset() {
  const now = new Date();
  const resetDay = new Date('2026-01-26T00:00:00'); // Starting day
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;

  let nextReset = new Date(resetDay.getTime());
  while (nextReset <= now) nextReset = new Date(nextReset.getTime() + msPerWeek);

  const delay = nextReset - now;
  console.log(`Next leaderboard reset scheduled in ${Math.round(delay / 1000 / 60)} minutes`);

  setTimeout(async () => {
    await pool.query(`UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0`);
    console.log('✅ Weekly leaderboard reset complete!');
    await updateLeaderboard();
    scheduleWeeklyReset(); // Schedule next reset
  }, delay);
}

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
