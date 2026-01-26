import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
import pg from 'pg';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const pool = new pg.Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

const channelId = process.env.CHANNEL_ID;

let lastLeaderboardHash = '';

async function resetLeaderboardIfNeeded() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_reset (
        id SERIAL PRIMARY KEY,
        last_reset TIMESTAMP NOT NULL
      )
    `);

    const res = await pool.query('SELECT last_reset FROM leaderboard_reset ORDER BY last_reset DESC LIMIT 1');
    const now = new Date();

    if (!res.rows[0] || (now - new Date(res.rows[0].last_reset)) > 7 * 24 * 60 * 60 * 1000) {
      console.log('Resetting leaderboard for new week...');
      await pool.query('UPDATE ranch_stats SET milk = 0, eggs = 0, cattle = 0');
      if (res.rows[0]) {
        await pool.query('UPDATE leaderboard_reset SET last_reset = $1 WHERE id = $2', [now, res.rows[0].id]);
      } else {
        await pool.query('INSERT INTO leaderboard_reset(last_reset) VALUES($1)', [now]);
      }
    }
  } catch (err) {
    console.error('Error in resetLeaderboardIfNeeded:', err);
  }
}

async function updateLeaderboard() {
  try {
    await resetLeaderboardIfNeeded();

    const result = await pool.query('SELECT username, milk, eggs, cattle FROM ranch_stats ORDER BY (milk*1.25 + eggs*1.25 + cattle*160) DESC');

    const leaderboardArray = result.rows.map(row => {
      const total = (row.milk * 1.25) + (row.eggs * 1.25) + (row.cattle * 160);
      return {
        username: row.username,
        stats: {
          milk: row.milk,
          eggs: row.eggs,
          cattle: row.cattle
        },
        total
      };
    });

    let leaderboardText = '🏆 Beaver Farms — Leaderboard\n\n';
    leaderboardArray.forEach(entry => {
      leaderboardText += `${entry.username}\n🥛 Milk: ${entry.stats.milk}\n🥚 Eggs: ${entry.stats.eggs}\n🐄 Cattle: ${entry.stats.cattle}\n💰 Total: $${entry.total.toFixed(2)}\n\n`;
    });

    // Hash the current leaderboard
    const hash = crypto.createHash('md5').update(leaderboardText).digest('hex');

    // Only send if it changed
    if (hash !== lastLeaderboardHash) {
      const channel = await client.channels.fetch(channelId);
      await channel.send(leaderboardText);
      lastLeaderboardHash = hash;
      console.log('Leaderboard updated!');
    } else {
      console.log('Leaderboard unchanged — not posting.');
    }
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// Webhook endpoint
app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;

    // Parse webhook payload (example)
    const username = data.username.split(' ')[2] || data.username; // adjust if needed
    const eggsAdded = data.embeds?.[0]?.description.match(/Added Eggs.*: (\d+)/)?.[1] || 0;

    // Update DB
    await pool.query('UPDATE ranch_stats SET eggs = eggs + $1 WHERE username = $2', [eggsAdded, username]);

    console.log('Webhook received!', data);
    await updateLeaderboard();

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).send('Error');
  }
});

app.listen(8080, () => {
  console.log('Webhook server listening on port 8080');
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
