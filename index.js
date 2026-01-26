import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
import fetch from 'node-fetch';
const { Pool } = pkg;

// -------------------- POSTGRES CONNECTION --------------------
const pool = new Pool({
  host: 'postgres.railway.internal',
  user: 'postgres',
  password: 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA',
  database: 'railway',
  port: 5432,
});

// -------------------- DISCORD CLIENT --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const CHANNEL_ID = '1465062014626824347';
const WEBHOOK_SECRET = 'some-long-random-string';

// Track the message ID of the leaderboard
let leaderboardMessageId = null;

// -------------------- UTILITY FUNCTIONS --------------------

// Calculate total for a row
function calculateTotal(row) {
  const milkTotal = (row.milk || 0) * 1.25;
  const eggsTotal = (row.eggs || 0) * 1.25;
  const cattleTotal = (row.cattle || 0) * 160; // $200 minus 20% ranch cut
  return milkTotal + eggsTotal + cattleTotal;
}

// Reset leaderboard weekly
async function resetLeaderboardIfNeeded() {
  const now = new Date();
  const weekStart = new Date('2026-01-26T00:00:00Z'); // start date
  const weeksSince = Math.floor((now - weekStart) / (7 * 24 * 60 * 60 * 1000));

  const res = await pool.query('SELECT last_reset_week FROM leaderboard_reset LIMIT 1');
  const lastWeek = res.rows[0]?.last_reset_week ?? -1;

  if (lastWeek < weeksSince) {
    await pool.query('UPDATE ranch_stats SET milk=0, eggs=0, cattle=0');
    if (lastWeek === -1) {
      await pool.query('INSERT INTO leaderboard_reset(last_reset_week) VALUES ($1)', [weeksSince]);
    } else {
      await pool.query('UPDATE leaderboard_reset SET last_reset_week=$1', [weeksSince]);
    }
  }
}

// Update leaderboard message
async function updateLeaderboard() {
  await resetLeaderboardIfNeeded();

  const result = await pool.query('SELECT username, milk, eggs, cattle FROM ranch_stats ORDER BY username ASC');
  const rows = result.rows;

  let content = '🏆 Beaver Farms — Leaderboard\n\n';
  rows.forEach(row => {
    const total = calculateTotal(row);
    content += `${row.username}\n🥛 Milk: ${row.milk}\n🥚 Eggs: ${row.eggs}\n🐄 Cattle: ${row.cattle}\n💰 Total: $${total.toFixed(2)}\n\n`;
  });

  const channel = await client.channels.fetch(CHANNEL_ID);

  if (leaderboardMessageId) {
    // edit existing message
    const message = await channel.messages.fetch(leaderboardMessageId);
    await message.edit({ content });
  } else {
    // send new message and store its ID
    const message = await channel.send({ content });
    leaderboardMessageId = message.id;
  }
}

// -------------------- WEBHOOK --------------------
import express from 'express';
const app = express();
app.use(express.json());

app.post('/webhook/ranch', async (req, res) => {
  const payload = req.body;

  // Basic secret check
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const username = payload.username.split(' ')[1]; // adjust as needed
    const items = payload.embeds[0]?.description || '';
    const milkMatch = items.match(/Milk: (\d+)/i);
    const eggsMatch = items.match(/Eggs: (\d+)/i);
    const cattleMatch = items.match(/Cattle: (\d+)/i);

    const milk = milkMatch ? parseInt(milkMatch[1], 10) : 0;
    const eggs = eggsMatch ? parseInt(eggsMatch[1], 10) : 0;
    const cattle = cattleMatch ? parseInt(cattleMatch[1], 10) : 0;

    await pool.query(
      `INSERT INTO ranch_stats(username, milk, eggs, cattle)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (username)
       DO UPDATE SET milk=ranch_stats.milk+$2, eggs=ranch_stats.eggs+$3, cattle=ranch_stats.cattle+$4`,
      [username, milk, eggs, cattle]
    );

    await updateLeaderboard();
    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// -------------------- START BOT --------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
});

client.login('MTQ2NTAyMTUzMzkyNjk4MTg1OQ.Gnl20w.W4CHBZRgFirMqNAFbJUdbdwyQGNh_p4qChpg0s');
app.listen(8080, () => console.log('Webhook server listening on port 8080'));
