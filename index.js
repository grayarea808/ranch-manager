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

let leaderboardMessageId = null; // store the ID of the message to edit

// --- FUNCTIONS ---
async function fetchLeaderboard() {
  const result = await pool.query('SELECT * FROM leaderboard ORDER BY total DESC');
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
    const rows = await fetchLeaderboard();
    if (!rows.length) return;

    const formatted = formatLeaderboard(rows);
    const channel = await client.channels.fetch(CHANNEL_ID);

    if (leaderboardMessageId) {
      // edit existing message
      const msg = await channel.messages.fetch(leaderboardMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ content: formatted });
        return;
      }
    }

    // send new message if none exists
    const sentMsg = await channel.send(formatted);
    leaderboardMessageId = sentMsg.id;

  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }
}

// --- CLIENT EVENTS ---
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateLeaderboard();
  setInterval(updateLeaderboard, 60 * 1000); // update every 60s
});

// --- LOGIN ---
client.login(DISCORD_TOKEN);
