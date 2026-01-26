// ---------------------
// Imports
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
  ssl: { rejectUnauthorized: false } // required for Railway
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
app.use(bodyParser.json());

app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;
    console.log('📩 Webhook received!', JSON.stringify(data, null, 2));

    // Parse username and amounts from webhook payload
    const username = data.username;
    let milk = 0, eggs = 0, cattle = 0;

    if (data.embeds && data.embeds[0] && data.embeds[0].description) {
      const desc = data.embeds[0].description;
      const milkMatch = desc.match(/Added Milk.*?: (\d+)/);
      const eggsMatch = desc.match(/Added Eggs.*?: (\d+)/);
      const cattleMatch = desc.match(/Added Cattle.*?: (\d+)/);
      if (milkMatch) milk = parseInt(milkMatch[1]);
      if (eggsMatch) eggs = parseInt(eggsMatch[1]);
      if (cattleMatch) cattle = parseInt(cattleMatch[1]);
    }

    // Update ranch_stats table
    await pool.query(`
      INSERT INTO ranch_stats(username, milk, eggs, cattle)
      VALUES($1, $2, $3, $4)
      ON CONFLICT (username) 
      DO UPDATE SET 
        milk = ranch_stats.milk + EXCLUDED.milk,
        eggs = ranch_stats.eggs + EXCLUDED.eggs,
        cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milk, eggs, cattle]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Start webhook server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 min
});

// ---------------------
// Leaderboard Function
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
        (milk*1.25 + eggs*1.25 + cattle*200*0.2) AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      const total = parseFloat(row.total) || 0;
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle}\n`;
      leaderboardMessage += `💰 Total: $${total.toFixed(2)}\n\n`;
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
import cron from 'node-cron';

// Runs every Monday at 00:00 UTC
cron.schedule('0 0 * * 1', async () => {
  try {
    await pool.query('UPDATE ranch_stats SET milk=0, eggs=0, cattle=0');
    console.log('🗑️ Weekly ranch stats reset');
    await updateLeaderboard();
  } catch (err) {
    console.error('Error resetting weekly stats:', err);
  }
});

// ---------------------
// Discord Login
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login Discord bot:', err);
});
