// ---------------------
// Imports
// ---------------------
import pkg from 'pg';
import express from 'express';
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
  ssl: { rejectUnauthorized: false } // Railway requires this
});

// ---------------------
// Express Webhook Setup
// ---------------------
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

app.post('/webhook/ranch', async (req, res) => {
  try {
    console.log('📩 Webhook received!', req.body);

    const { username, milkAdded, eggsAdded, cattleAdded } = parseWebhook(req.body);

    // Upsert user into ranch_stats
    await pool.query(
      `
      INSERT INTO ranch_stats (username, milk, eggs, cattle)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO UPDATE
      SET milk = ranch_stats.milk + $2,
          eggs = ranch_stats.eggs + $3,
          cattle = ranch_stats.cattle + $4
      `,
      [username, milkAdded, eggsAdded, cattleAdded]
    );

    await updateLeaderboard();

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // update every 5 minutes
});

// ---------------------
// Parse Webhook
// ---------------------
function parseWebhook(payload) {
  // Adjust this based on your game’s exact payload
  // Example based on your previous webhook:
  const embed = payload.embeds?.[0]?.description || '';
  const parts = embed.split('\n')[0].split(' ');
  const username = parts.slice(1).join(' '); // "<@id> USERNAME" → "USERNAME"

  // Extract numbers from description (milk, eggs, cattle)
  let milkAdded = 0, eggsAdded = 0, cattleAdded = 0;
  if (/Milk/i.test(embed)) milkAdded = Number(embed.match(/: (\d+)/)?.[1] || 0);
  if (/Eggs/i.test(embed)) eggsAdded = Number(embed.match(/: (\d+)/)?.[1] || 0);
  if (/Cattle/i.test(embed)) cattleAdded = Number(embed.match(/: (\d+)/)?.[1] || 0);

  return { username, milkAdded, eggsAdded, cattleAdded };
}

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username,
             COALESCE(milk,0) AS milk,
             COALESCE(eggs,0) AS eggs,
             COALESCE(cattle,0) AS cattle,
             COALESCE(milk,0)*1.1 + COALESCE(eggs,0)*1.1 + COALESCE(cattle,0) AS total
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
// Login Discord Bot
// ---------------------
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('🚨 Failed to login Discord bot:', err);
});
