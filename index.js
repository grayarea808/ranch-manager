import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// --- CONFIG ---
const {
  CHANNEL_ID,
  GUILD_ID,
  DISCORD_TOKEN,
  PGHOST,
  PGUSER,
  PGPASSWORD,
  PGDATABASE,
  PGPORT
} = process.env;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const pool = new Pool({
  host: PGHOST,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  port: PGPORT,
  ssl: false
});

// --- CONSTANTS ---
const MILK_PRICE = 1.25;
const EGG_PRICE = 1.25;
const CATTLE_PRICE = 200;
const RANCH_CUT = 0.2; // 20% cut
const RESET_INTERVAL_DAYS = 7;

// --- STATE ---
let leaderboardMessageId = null;

// --- DATABASE SETUP ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      milk INT DEFAULT 0,
      eggs INT DEFAULT 0,
      cattle INT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_reset (
      id SERIAL PRIMARY KEY,
      last_reset TIMESTAMP NOT NULL
    )
  `);

  // ensure there’s a row in leaderboard_reset
  const res = await pool.query('SELECT * FROM leaderboard_reset LIMIT 1');
  if (res.rows.length === 0) {
    await pool.query(`INSERT INTO leaderboard_reset(last_reset) VALUES($1)`, [new Date()]);
  }
}

// --- LEADERBOARD HELPERS ---
async function resetLeaderboardIfNeeded() {
  const res = await pool.query('SELECT last_reset FROM leaderboard_reset LIMIT 1');
  const lastReset = new Date(res.rows[0].last_reset);
  const now = new Date();
  const diffDays = (now - lastReset) / (1000 * 60 * 60 * 24);

  if (diffDays >= RESET_INTERVAL_DAYS) {
    await pool.query('UPDATE leaderboard SET milk = 0, eggs = 0, cattle = 0');
    await pool.query('UPDATE leaderboard_reset SET last_reset = $1', [now]);
    console.log('Leaderboard reset for new week!');
  }
}

async function fetchLeaderboard() {
  const result = await pool.query('SELECT * FROM leaderboard ORDER BY (milk*$1 + eggs*$2 + cattle*($3*(1-$4))) DESC', [MILK_PRICE, EGG_PRICE, CATTLE_PRICE, RANCH_CUT]);
  return result.rows;
}

function formatLeaderboard(rows) {
  return ['🏆 Beaver Farms — Leaderboard', ...rows.map(row => {
    const milkTotal = row.milk * MILK_PRICE;
    const eggsTotal = row.eggs * EGG_PRICE;
    const cattleTotal = row.cattle * (CATTLE_PRICE * (1 - RANCH_CUT));
    const total = milkTotal + eggsTotal + cattleTotal;

    return `@${row.username} ${row.username.toUpperCase()}
🥛 Milk: ${row.milk}
🥚 Eggs: ${row.eggs}
🐄 Cattle: ${row.cattle}
💰 Total: $${total.toFixed(2)}`;
  })].join('\n\n');
}

async function updateLeaderboard() {
  try {
    await resetLeaderboardIfNeeded();
    const rows = await fetchLeaderboard();
    if (!rows.length) return;

    const formatted = formatLeaderboard(rows);
    const channel = await client.channels.fetch(CHANNEL_ID);

    if (leaderboardMessageId) {
      const msg = await channel.messages.fetch(leaderboardMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ content: formatted });
        return;
      }
    }

    const sentMsg = await channel.send(formatted);
    leaderboardMessageId = sentMsg.id;

  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// --- CLIENT EVENTS ---
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();
  updateLeaderboard();
  setInterval(updateLeaderboard, 60 * 1000); // update every 60s
});

// --- LOGIN ---
client.login(DISCORD_TOKEN);
