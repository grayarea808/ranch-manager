import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// --- CONFIG ---
const CHANNEL_ID = '1465062014626824347';
const GUILD_ID = '1463920085155446930';
const DISCORD_TOKEN = 'MTQ2NTAyMTUzMzkyNjk4MTg1OQ.Gnl20w.W4CHBZRgFirMqNAFbJUdbdwyQGNh_p4qChpg0s';

// Postgres (Railway) config
const pool = new Pool({
  host: 'postgres.railway.internal',
  user: 'postgres',
  password: 'nZgFXhBgBmJxTXfqLDFrhhMOJyNQpOLA',
  database: 'railway',
  port: 5432
});

// Prices
const PRICES = {
  milk: 1.25,
  eggs: 1.25,
  cattle: 160 // after 20% cut
};

// Leaderboard message ID (store after first post)
let LEADERBOARD_MESSAGE_ID = null;

// --- DISCORD CLIENT ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);

  // Fetch existing leaderboard message
  const messages = await channel.messages.fetch({ limit: 50 });
  const lbMessage = messages.find(m => m.author.id === client.user.id && m.content.startsWith('🏆 Beaver Farms'));

  if (lbMessage) LEADERBOARD_MESSAGE_ID = lbMessage.id;

  // Update leaderboard immediately
  await updateLeaderboard(channel);

  // Then update every 30 seconds (or adjust)
  setInterval(() => updateLeaderboard(channel), 30000);
});

client.login(DISCORD_TOKEN);

// --- FUNCTIONS ---
async function getLeaderboardData() {
  const res = await pool.query('SELECT username, milk, eggs, cattle FROM leaderboard ORDER BY username');
  return res.rows;
}

function formatLeaderboard(rows) {
  let text = '🏆 Beaver Farms — Leaderboard\n\n';
  for (const row of rows) {
    const total = (row.milk * PRICES.milk) + (row.eggs * PRICES.eggs) + (row.cattle * PRICES.cattle);
    text += `@${row.username} ${row.username.toUpperCase()}\n`;
    text += `🥛 Milk: ${row.milk}\n`;
    text += `🥚 Eggs: ${row.eggs}\n`;
    text += `🐄 Cattle: ${row.cattle}\n`;
    text += `💰 Total: $${total.toFixed(2)}\n\n`;
  }
  return text.trim();
}

async function updateLeaderboard(channel) {
  const rows = await getLeaderboardData();
  const content = formatLeaderboard(rows);

  if (LEADERBOARD_MESSAGE_ID) {
    try {
      const msg = await channel.messages.fetch(LEADERBOARD_MESSAGE_ID);
      await msg.edit({ content });
    } catch {
      // If the old message was deleted
      const newMsg = await channel.send({ content });
      LEADERBOARD_MESSAGE_ID = newMsg.id;
    }
  } else {
    const msg = await channel.send({ content });
    LEADERBOARD_MESSAGE_ID = msg.id;
  }
}

// --- DATABASE UPSERT ---
export async function upsertUser(username, milk, eggs, cattle) {
  const query = `
    INSERT INTO leaderboard (username, milk, eggs, cattle)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (username)
    DO UPDATE SET
      milk = EXCLUDED.milk,
      eggs = EXCLUDED.eggs,
      cattle = EXCLUDED.cattle;
  `;
  await pool.query(query, [username, milk, eggs, cattle]);
}

// --- WEEKLY RESET ---
async function resetLeaderboard() {
  const today = new Date();
  if (today.getDay() === 0) { // Sunday reset
    await pool.query('UPDATE leaderboard SET milk = 0, eggs = 0, cattle = 0');
    console.log('Leaderboard reset!');
  }
}

// Check for weekly reset every hour
setInterval(resetLeaderboard, 3600000);
