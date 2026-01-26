import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import pg from 'pg';

const { Pool } = pg;

// ----- DATABASE -----
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
});

// ----- DISCORD CLIENT -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ----- CONFIG -----
const CHANNEL_ID = process.env.CHANNEL_ID; // where leaderboard is posted

let leaderboardMessageId = null; // stores the single message id

// ----- HELPER: FETCH LEADERBOARD -----
async function fetchLeaderboard() {
  const res = await pool.query(
    'SELECT username, milk, eggs, cattle, total FROM leaderboard ORDER BY total DESC'
  );
  return res.rows;
}

// ----- HELPER: FORMAT LEADERBOARD -----
function formatLeaderboard(rows) {
  let msg = `🏆 Beaver Farms — Leaderboard\n`;
  for (const row of rows) {
    msg += `${row.username.toUpperCase()}\n`;
    msg += `🥛 Milk: ${row.milk}\n`;
    msg += `🥚 Eggs: ${row.eggs}\n`;
    msg += `🐄 Cattle: ${row.cattle}\n`;
    msg += `💰 Total: $${row.total.toFixed(2)}\n\n`;
  }
  return msg.trim();
}

// ----- UPDATE LEADERBOARD -----
async function updateLeaderboard() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !(channel instanceof TextChannel)) return;

  const rows = await fetchLeaderboard();
  const content = formatLeaderboard(rows);

  if (leaderboardMessageId) {
    try {
      const msg = await channel.messages.fetch(leaderboardMessageId);
      await msg.edit(content);
      console.log('Leaderboard updated!');
      return;
    } catch (err) {
      console.log('Previous message not found, sending a new one.');
    }
  }

  // Send new message if none exists
  const msg = await channel.send(content);
  leaderboardMessageId = msg.id;
  console.log('Leaderboard posted!');
}

// ----- CLIENT READY -----
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();

  // Optional: update every 5 minutes
  setInterval(updateLeaderboard, 5 * 60 * 1000);
});

// ----- LOGIN -----
client.login(process.env.DISCORD_TOKEN);
