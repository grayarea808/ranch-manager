import express from 'express';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

// --------------------
// CONFIG
// --------------------
const CHANNEL_ID = '1465062014626824347'; // Discord channel
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // Railway token variable

const PGHOST = 'postgres.railway.internal';
const PGUSER = 'postgres';
const PGPASSWORD = 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA';
const PGDATABASE = 'railway';
const PGPORT = 5432;

// --------------------
// POSTGRES SETUP
// --------------------
const pool = new Pool({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT,
});

// Leaderboard table
await pool.query(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    milk INT DEFAULT 0,
    eggs INT DEFAULT 0,
    cattle INT DEFAULT 0,
    total INT DEFAULT 0
  );
`);

// --------------------
// EXPRESS SETUP
// --------------------
const app = express();
app.use(express.json()); // parse JSON bodies

// --------------------
// DISCORD SETUP
// --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let leaderboardMessageId = null;

// --------------------
// LEADERBOARD FUNCTIONS
// --------------------
async function updateLeaderboard() {
  try {
    const res = await pool.query(`
      SELECT username, milk, eggs, cattle, total
      FROM leaderboard
      ORDER BY total DESC
      LIMIT 10
    `);

    let content = '🏆 Beaver Farms — Leaderboard\n\n';
    if (res.rows.length === 0) {
      content += 'No data yet.';
    } else {
      for (const row of res.rows) {
        content += `${row.username.toUpperCase()}\n`;
        content += `🥛 Milk: ${row.milk}\n`;
        content += `🥚 Eggs: ${row.eggs}\n`;
        content += `🐄 Cattle: ${row.cattle}\n`;
        content += `💰 Total: $${row.total}\n\n`;
      }
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (leaderboardMessageId) {
      const msg = await channel.messages.fetch(leaderboardMessageId);
      await msg.edit(content);
    } else {
      const msg = await channel.send(content);
      leaderboardMessageId = msg.id;
    }

    console.log('📊 Leaderboard updated');
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// --------------------
// WEBHOOK ROUTE
// --------------------
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Webhook payload:', req.body);

    const { username, milk = 0, eggs = 0, cattle = 0 } = req.body;
    const total = milk + eggs + cattle;

    // Insert or update user
    await pool.query(`
      INSERT INTO leaderboard (username, milk, eggs, cattle, total)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username) DO UPDATE SET
        milk = leaderboard.milk + EXCLUDED.milk,
        eggs = leaderboard.eggs + EXCLUDED.eggs,
        cattle = leaderboard.cattle + EXCLUDED.cattle,
        total = leaderboard.milk + leaderboard.eggs + leaderboard.cattle
            + EXCLUDED.milk + EXCLUDED.eggs + EXCLUDED.cattle;
    `, [username, milk, eggs, cattle, total]);

    await updateLeaderboard();
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// --------------------
// WEEKLY RESET - Every Sunday at 00:00
// --------------------
cron.schedule('0 0 * * 0', async () => {
  try {
    await pool.query('UPDATE leaderboard SET milk = 0, eggs = 0, cattle = 0, total = 0;');
    console.log('♻️ Leaderboard reset for new week');
    await updateLeaderboard();
  } catch (err) {
    console.error('Error resetting leaderboard:', err);
  }
});

// --------------------
// CLIENT READY
// --------------------
client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  const messages = await channel.messages.fetch({ limit: 10 });
  const lastLeaderboard = messages.find(
    (msg) => msg.author.id === client.user.id && msg.content.startsWith('🏆 Beaver Farms — Leaderboard')
  );
  if (lastLeaderboard) leaderboardMessageId = lastLeaderboard.id;
  else {
    const msg = await channel.send('🏆 Beaver Farms — Leaderboard\nFetching data...');
    leaderboardMessageId = msg.id;
  }

  await updateLeaderboard();
});

// --------------------
// START EXPRESS & DISCORD
// --------------------
client.login(DISCORD_TOKEN);
app.listen(8080, () => console.log('🚜 Ranch Manager running on port 8080'));

// --- Weekly Reset System (no node-cron needed) ---
function scheduleWeeklyReset() {
  // Run every minute and check if it's Sunday midnight
  setInterval(async () => {
    const now = new Date();
    // Sunday is 0, midnight is 0 hours
    if (now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() === 0) {
      console.log("🔄 Weekly reset triggered");

      try {
        // Reset all user stats in your database
        await pool.query(`
          UPDATE users
          SET eggs = 0, milk = 0, cattle = 0, total = 0
        `);

        console.log("✅ All ranch stats reset for the new week");

        // Optional: update the Discord leaderboard immediately
        updateLeaderboard();

      } catch (err) {
        console.error("❌ Error during weekly reset:", err);
      }
    }
  }, 60 * 1000); // check every minute
}

// Call it once at startup
scheduleWeeklyReset();


