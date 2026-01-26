// ---------------------
// Imports
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
  ssl: { rejectUnauthorized: false } // Railway requires this
});

// ---------------------
// Express / Webhook Setup
// ---------------------
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

app.post('/webhook/ranch', async (req, res) => {
  try {
    const data = req.body;

    // Example payload parsing
    // Adjust these paths if your game payload differs
    const description = data.embeds?.[0]?.description;
    if (!description) return res.sendStatus(400);

    const match = description.match(/Added (\w+) to ranch id \d+ : (\d+)/i);
    if (!match) return res.sendStatus(400);

    const [_, resource, amountStr] = match;
    const amount = parseInt(amountStr, 10);

    // Extract username from payload
    const usernameMatch = description.match(/<@(\d+)>/);
    const username = usernameMatch ? `<@${usernameMatch[1]}>` : data.username || 'Unknown';

    // Upsert into ranch_stats
    const column = resource.toLowerCase(); // milk, eggs, or cattle
    await pool.query(`
      INSERT INTO ranch_stats(username, ${column})
      VALUES($1, $2)
      ON CONFLICT(username) DO UPDATE
      SET ${column} = ranch_stats.${column} + $2
    `, [username, amount]);

    console.log(`Webhook processed: ${username} +${amount} ${column}`);
    updateLeaderboard(); // Update leaderboard immediately
    res.sendStatus(200);

  } catch (err) {
    console.error('Error processing webhook:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

// ---------------------
// Discord Setup
// ---------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// ---------------------
// Bot Ready
// ---------------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 5 * 60 * 1000); // Update every 5 minutes
});

// ---------------------
// Update Leaderboard
// ---------------------
async function updateLeaderboard() {
  try {
    const result = await pool.query(`
      SELECT username, milk, eggs, cattle, 
             (COALESCE(milk,0)*1.1 + COALESCE(eggs,0)*1.1 + COALESCE(cattle,0)) AS total
      FROM ranch_stats
      ORDER BY total DESC
      LIMIT 10
    `);

    let leaderboardMessage = '🏆 Beaver Farms — Leaderboard\n\n';
    result.rows.forEach((row, i) => {
      leaderboardMessage += `${i + 1}. ${row.username}\n`;
      leaderboardMessage += `🥛 Milk: ${row.milk || 0}\n`;
      leaderboardMessage += `🥚 Eggs: ${row.eggs || 0}\n`;
      leaderboardMessage += `🐄 Cattle: ${row.cattle || 0}\n`;
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
