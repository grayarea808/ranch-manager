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
import bodyParser from 'body-parser';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Weekly Reset Setup
// ---------------------
function scheduleWeeklyReset() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  const nextSunday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilSunday,
    0, 0, 0
  ));
  const timeout = nextSunday - now;

  setTimeout(async () => {
    try {
      await pool.query('TRUNCATE ranch_log;');
      console.log('Weekly ranch stats reset!');
    } catch (err) {
      console.error('Error resetting weekly stats:', err);
    }
    scheduleWeeklyReset(); // schedule next week
  }, timeout);
}

// ---------------------
// Leaderboard Update
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username,
             SUM(milk) AS milk,
             SUM(eggs) AS eggs,
             SUM(cattle) AS cattle,
             SUM(milk*1.25 + eggs*1.25 + cattle) AS total
      FROM ranch_log
      GROUP BY username
      ORDER BY total DESC
      LIMIT 10;
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Weekly Leaderboard\n\n';
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
  const data = req.body;
  console.log('📩 Webhook received!', JSON.stringify(data, null, 2));

  try {
    // Extract username, milk, eggs, cattle from payload
    const username = data.username;
    const milkAdded = data.milk || 0;
    const eggsAdded = data.eggs || 0;
    const cattleAdded = data.cattle || 0;

    await pool.query(
      `INSERT INTO ranch_log (username, milk, eggs, cattle)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
       SET milk = ranch_log.milk + EXCLUDED.milk,
           eggs = ranch_log.eggs + EXCLUDED.eggs,
           cattle = ranch_log.cattle + EXCLUDED.cattle;`,
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
// Start Servers & Bot
// ---------------------
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  scheduleWeeklyReset();
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login Discord bot:', err);
});
