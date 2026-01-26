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
  ssl: { rejectUnauthorized: false } // Required on Railway
});

// ---------------------
// Discord Setup
// ---------------------
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
import bodyParser from 'body-parser';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const app = express();
app.use(bodyParser.json());

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Helper: Reset Leaderboard Weekly
// ---------------------
async function resetLeaderboardIfNeeded() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_reset (
        id SERIAL PRIMARY KEY,
        last_reset TIMESTAMP NOT NULL
      );
    `);

    const { rows } = await pool.query(`SELECT last_reset FROM leaderboard_reset ORDER BY last_reset DESC LIMIT 1`);
    const lastReset = rows[0]?.last_reset;
    const now = new Date();

    if (!lastReset || now - new Date(lastReset) > 7 * 24 * 60 * 60 * 1000) {
      // Reset ranch stats
      await pool.query(`UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0`);
      if (lastReset) {
        await pool.query(`UPDATE leaderboard_reset SET last_reset = $1 WHERE id = 1`, [now]);
      } else {
        await pool.query(`INSERT INTO leaderboard_reset(last_reset) VALUES ($1)`, [now]);
      }
      console.log('Leaderboard reset for the week!');
    }
  } catch (err) {
    console.error('Error resetting leaderboard:', err);
  }
}

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  await resetLeaderboardIfNeeded();

  try {
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
      leaderboardMessage += `💰 Total: $${Number(row.total).toFixed(2)}\n\n`;
    });

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.error('Channel not found!');

    // Fetch last 10 messages and edit the one from this bot
    const messages = await channel.messages.fetch({ limit: 10 });
    const botMessage = messages.find(m => m.author.id === client.user.id && m.content.startsWith('🏆 Beaver Farms'));
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
// Webhook Listener
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;

    // Example payload parsing: add eggs/milk/cattle automatically
    const username = data.username;
    let milk = 0, eggs = 0, cattle = 0;

    if (data.embeds?.[0]?.title?.includes('Eggs Added')) {
      eggs = Number(data.embeds[0].description.split(':').pop().trim());
    }
    if (data.embeds?.[0]?.title?.includes('Milk Added')) {
      milk = Number(data.embeds[0].description.split(':').pop().trim());
    }
    if (data.embeds?.[0]?.title?.includes('Cattle Sold')) {
      cattle = Number(data.embeds[0].description.split(':').pop().trim());
    }

    // Upsert user in ranch_stats
    await pool.query(`
      INSERT INTO ranch_stats(username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO UPDATE
      SET milk = ranch_stats.milk + $2,
          eggs = ranch_stats.eggs + $3,
          cattle = ranch_stats.cattle + $4
    `, [username, milk, eggs, cattle]);

    console.log('📩 Webhook received!', data);
    await updateLeaderboard();
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Error');
  }
});

// ---------------------
// Start Webhook Server
// ---------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// ---------------------
// Discord Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // every 5 min
});

// ---------------------
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Failed to login Discord bot:', err));
