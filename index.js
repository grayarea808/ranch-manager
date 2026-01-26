// ---------------------
// Imports & Setup
// ---------------------
import pkg from 'pg';
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
const { Pool } = pkg;

const app = express();
app.use(express.json());

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT),
  ssl: { rejectUnauthorized: false } // Required for Railway
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Discord Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // update every 5 mins
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login Discord bot:', err);
});

// ---------------------
// Weekly Reset Setup
// ---------------------
const leaderboardStart = new Date('2026-01-26'); // start date
function shouldResetLeaderboard() {
  const now = new Date();
  const diff = now - leaderboardStart;
  const diffWeeks = Math.floor(diff / (1000 * 60 * 60 * 24 * 7));
  return diffWeeks > 0 && now.getDay() === leaderboardStart.getDay(); // same day weekly
}

async function resetLeaderboard() {
  try {
    await pool.query('UPDATE ranch_stats SET milk=0, eggs=0, cattle=0');
    console.log('Leaderboard reset for the new week!');
  } catch (err) {
    console.error('Error resetting leaderboard:', err);
  }
}

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    if (shouldResetLeaderboard()) await resetLeaderboard();

    const result = await pool.query(`
      SELECT username, milk, eggs, cattle,
             milk*1.25 + eggs*1.25 + cattle*200*0.2 AS total
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
// Webhook Endpoint
// ---------------------
app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;
    console.log('📩 Webhook received!', JSON.stringify(data, null, 2));

    const username = data.username; // adjust based on your webhook
    let milk = 0, eggs = 0, cattle = 0;

    if (data.embeds) {
      data.embeds.forEach(embed => {
        const desc = embed.description || '';
        if (desc.includes('Milk')) milk += parseInt(desc.match(/\d+/)?.[0] || '0');
        if (desc.includes('Eggs')) eggs += parseInt(desc.match(/\d+/)?.[0] || '0');
        if (desc.includes('Cattle')) cattle += parseInt(desc.match(/\d+/)?.[0] || '0');
      });
    }

    // Upsert data
    await pool.query(`
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO UPDATE
      SET milk = ranch_stats.milk + EXCLUDED.milk,
          eggs = ranch_stats.eggs + EXCLUDED.eggs,
          cattle = ranch_stats.cattle + EXCLUDED.cattle
    `, [username, milk, eggs, cattle]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.sendStatus(500);
  }
});

// ---------------------
// Start Webhook Server
// ---------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
