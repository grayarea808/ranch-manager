import express from "express";
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import pg from "pg";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID; // where the reset embed lives
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 300);
const POLL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const LEADERBOARD_DEBOUNCE_MS = 2000; // requested

const RANCH_NAME = process.env.RANCH_NAME || "Beaver Falls";
const CAMP_NAME = process.env.CAMP_NAME || "Beaver Falls Camp";

const PRICE_EGGS = 1.25;
const PRICE_MILK = 1.25;

// =====================
// VALIDATION
// =====================
function must(name) {
  if (!process.env[name]) throw new Error(`❌ Missing Railway variable: ${name}`);
}
[
  "DISCORD_TOKEN",
  "DATABASE_URL",
  "ADMIN_KEY",
  "RANCH_INPUT_CHANNEL_ID",
  "RANCH_OUTPUT_CHANNEL_ID",
  "CAMP_INPUT_CHANNEL_ID",
  "CAMP_OUTPUT_CHANNEL_ID",
  "CONTROL_CHANNEL_ID",
  "ADMIN_USER_IDS",
].forEach(must);

// =====================
// APP + DB + DISCORD
// =====================
const app = express();
app.use(express.json());

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// =====================
// DB MIGRATION (SAFE)
// =====================
async function ensureTablesAndMigrate() {
  // bot_state always exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure ranch_events exists (if it doesn't, create fresh)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranch_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT,
      user_id BIGINT,
      kind TEXT,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure camp_events exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS camp_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT,
      user_id BIGINT,
      kind TEXT,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // If you had older schemas, add missing cols (won’t fail if already there)
  await pool.query(`
    ALTER TABLE ranch_events
      ADD COLUMN IF NOT EXISTS source_message_id BIGINT,
      ADD COLUMN IF NOT EXISTS user_id BIGINT,
      ADD COLUMN IF NOT EXISTS kind TEXT,
      ADD COLUMN IF NOT EXISTS qty NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE camp_events
      ADD COLUMN IF NOT EXISTS source_message_id BIGINT,
      ADD COLUMN IF NOT EXISTS user_id BIGINT,
      ADD COLUMN IF NOT EXISTS kind TEXT,
      ADD COLUMN IF NOT EXISTS qty NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Unique indexes for dedupe
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='ranch_events' AND indexname='ranch_events_source_message_id_uq'
      ) THEN
        CREATE UNIQUE INDEX ranch_events_source_message_id_uq
          ON ranch_events(source_message_id)
          WHERE source_message_id IS NOT NULL;
      END IF;
    END $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='camp_events' AND indexname='camp_events_source_message_id_uq'
      ) THEN
        CREATE UNIQUE INDEX camp_events_source_message_id_uq
          ON camp_events(source_message_id)
          WHERE source_message_id IS NOT NULL;
      END IF;
    END $$;
  `);
}

async function getState(key) {
  const { rows } = await pool.query(`SELECT value FROM bot_state WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}
async function setState(key, value) {
  await pool.query(
    `INSERT INTO bot_state(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, String(value)]
  );
}

// =====================
// DISCORD HELPERS
// =====================
async function fetchChannel(channelId) {
  const ch = await client.channels.fetch(channelId);
  if (!ch) throw new Error(`Channel not found: ${channelId}`);
  return ch;
}

async function ensureSingleMessage(channelId, stateKey, initialContent, extra = {}) {
  const ch = await fetchChannel(channelId);
  let msgId = await getState(stateKey);

  if (msgId) {
    try {
      const msg = await ch.messages.fetch(msgId);
      return msg;
    } catch {
      // deleted -> recreate
    }
  }

  const msg = await ch.send({ content: initialContent, ...extra });
  await setState(stateKey, msg.id);
  return msg;
}

// =====================
// PARSERS
// =====================
function parseUserId(text) {
  const m1 = text.match(/<@(\d{15,20})>/);
  if (m1) return m1[1];
  const m2 = text.match(/Discord:\s*@.*?(\d{15,20})/i);
  if (m2) return m2[1];
  const m3 = text.match(/@[\w\-\.\s]+\s+(\d{15,20})/); // @name 123...
  if (m3) return m3[1];
  return null;
}

function parseRanchLog(text) {
  const userId = parseUserId(text);
  if (!userId) return null;

  const eggs = text.match(/Added Eggs.*?:\s*(\d+)/i);
  if (eggs) return { user_id: userId, kind: "eggs", qty: Number(eggs[1]), amount: 0 };

  const milk = text.match(/Added Milk.*?:\s*(\d+)/i);
  if (milk) return { user_id: userId, kind: "milk", qty: Number(milk[1]), amount: 0 };

  const sale = text.match(/sold\s+(\d+)\s+([A-Za-z ]+)\s+for\s+([\d.]+)\$/i);
  if (sale) {
    const animals = Number(sale[1]);
    const value = Number(sale[3]);
    return { user_id: userId, kind: "cattle_sale", qty: animals, amount: value };
  }

  return null;
}

function parseCampLog(text) {
  const userId = parseUserId(text);
  if (!userId) return null;

  const supplies = text.match(/Delivered Supplies:\s*(\d+)/i);
  if (supplies) return { user_id: userId, kind: "supplies", qty: Number(supplies[1]), amount: 0 };

  const mats = text.match(/Materials added:\s*([\d.]+)/i);
  if (mats) return { user_id: userId, kind: "materials", qty: Number(mats[1]), amount: 0 };

  // "Made a Sale Of 100 Of Stock For $1900"
  const sale = text.match(/Made a Sale Of\s+\d+\s+Of Stock For\s+\$?([\d.]+)/i);
  if (sale) return { user_id: userId, kind: "delivery", qty: 1, amount: Number(sale[1]) };

  return null;
}

// =====================
// INSERT (DEDUPE BY source_message_id)
// =====================
async function insertRanchEvent(messageId, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO ranch_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id) DO NOTHING
    `,
    [String(messageId), String(evt.user_id), evt.kind, evt.qty, evt.amount, createdAtIso || new Date().toISOString()]
  );
}

async function insertCampEvent(messageId, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO camp_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id) DO NOTHING
    `,
    [String(messageId), String(evt.user_id), evt.kind, evt.qty, evt.amount, createdAtIso || new Date().toISOString()]
  );
}

// =====================
// RENDER BOARDS
// =====================
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}
function badge(i) {
  return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
}

async function ranchTotalsSince(weekStartIso) {
  const { rows } = await pool.query(
    `
    SELECT
      user_id,
      SUM(CASE WHEN kind='eggs' THEN qty ELSE 0 END) AS eggs,
      SUM(CASE WHEN kind='milk' THEN qty ELSE 0 END) AS milk,
      SUM(CASE WHEN kind='cattle_sale' THEN qty ELSE 0 END) AS animals_sold,
      SUM(CASE WHEN kind='cattle_sale' THEN amount ELSE 0 END) AS cattle_value
    FROM ranch_events
    WHERE created_at >= $1::timestamptz
      AND kind IS NOT NULL
    GROUP BY user_id
    `,
    [weekStartIso]
  );

  const users = rows.map((r) => {
    const eggs = Number(r.eggs || 0);
    const milk = Number(r.milk || 0);
    const animals_sold = Number(r.animals_sold || 0);
    const cattle_value = Number(r.cattle_value || 0);
    const payout = eggs * PRICE_EGGS + milk * PRICE_MILK + cattle_value;
    return { user_id: r.user_id, eggs, milk, animals_sold, payout };
  });

  users.sort((a, b) => b.payout - a.payout);
  return users;
}

async function renderRanchBoard() {
  const weekStartIso = (await getState("ranch_week_start")) || new Date().toISOString();
  const users = await ranchTotalsSince(weekStartIso);

  const totalMilk = users.reduce((a, u) => a + u.milk, 0);
  const totalEggs = users.reduce((a, u) => a + u.eggs, 0);
  const totalAnimals = users.reduce((a, u) => a + u.animals_sold, 0);
  const totalPayout = users.reduce((a, u) => a + u.payout, 0);

  const lines = [];
  lines.push(`🏆 **${RANCH_NAME} Ranch — Weekly Ledger**`);
  lines.push(`🥛 **${totalMilk.toLocaleString()}** • 🥚 **${totalEggs.toLocaleString()}** • 🐄 **Sold: ${totalAnimals.toLocaleString()}**`);
  lines.push(`💰 **Total Ranch Payout:** ${money(totalPayout)}`);
  lines.push("");

  const max = Math.min(users.length, 25);
  for (let i = 0; i < max; i++) {
    const u = users[i];
    lines.push(`${badge(i)} <@${u.user_id}> — 🥛${u.milk} 🥚${u.eggs} 🐄${u.animals_sold} — **${money(u.payout)}**`);
  }
  if (users.length > max) lines.push(`\n…and **${users.length - max}** more`);

  lines.push(`\n_Last updated: ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET_`);
  return lines.join("\n");
}

async function campTotalsSince(weekStartIso) {
  const { rows } = await pool.query(
    `
    SELECT
      user_id,
      SUM(CASE WHEN kind='materials' THEN qty ELSE 0 END) AS materials,
      SUM(CASE WHEN kind='supplies' THEN qty ELSE 0 END) AS supplies,
      SUM(CASE WHEN kind='delivery' THEN qty ELSE 0 END) AS deliveries,
      SUM(CASE WHEN kind='delivery' THEN amount ELSE 0 END) AS delivery_value
    FROM camp_events
    WHERE created_at >= $1::timestamptz
      AND kind IS NOT NULL
    GROUP BY user_id
    `,
    [weekStartIso]
  );

  const users = rows.map((r) => {
    const materials = Number(r.materials || 0);
    const supplies = Number(r.supplies || 0);
    const deliveries = Number(r.deliveries || 0);
    const delivery_value = Number(r.delivery_value || 0);

    const points = materials * 2 + supplies * 1 + deliveries * 3;
    const payout = delivery_value * 0.7; // 30% camp cut
    return { user_id: r.user_id, materials, supplies, deliveries, points, payout, delivery_value };
  });

  users.sort((a, b) => b.payout - a.payout);
  return users;
}

async function renderCampBoard() {
  const weekStartIso = (await getState("camp_week_start")) || new Date().toISOString();
  const users = await campTotalsSince(weekStartIso);

  const totalDelivery = users.reduce((a, u) => a + u.delivery_value, 0);
  const campRevenue = totalDelivery * 0.3;
  const totalPayout = users.reduce((a, u) => a + u.payout, 0);
  const totalPoints = users.reduce((a, u) => a + u.points, 0);

  const lines = [];
  lines.push(`🏕️ **${CAMP_NAME} — Weekly Ledger**`);
  lines.push(`Payout Mode: **Points (30% camp fee)**`);
  lines.push(`🧾 Delivery Value: **${money(totalDelivery)}** • 🪙 Camp Revenue: **${money(campRevenue)}**`);
  lines.push(`⭐ Total Points: **${totalPoints.toLocaleString()}** • 💰 Player Payouts: **${money(totalPayout)}**`);
  lines.push("");

  const max = Math.min(users.length, 25);
  for (let i = 0; i < max; i++) {
    const u = users[i];
    lines.push(`${badge(i)} <@${u.user_id}> — 🪨${u.materials} 📦${u.supplies} 🚚${u.deliveries} ⭐${u.points} — **${money(u.payout)}**`);
  }
  if (users.length > max) lines.push(`\n…and **${users.length - max}** more`);

  lines.push(`\n_Last updated: ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET_`);
  return lines.join("\n");
}

// =====================
// DEBOUNCED EDITS
// =====================
let ranchTimer = null;
let campTimer = null;

async function scheduleRanchUpdate() {
  clearTimeout(ranchTimer);
  ranchTimer = setTimeout(async () => {
    const msg = await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", "🏆 Loading ranch board…");
    const content = await renderRanchBoard();
    await msg.edit({ content });
  }, LEADERBOARD_DEBOUNCE_MS);
}

async function scheduleCampUpdate() {
  clearTimeout(campTimer);
  campTimer = setTimeout(async () => {
    const msg = await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", "🏕️ Loading camp board…");
    const content = await renderCampBoard();
    await msg.edit({ content });
  }, LEADERBOARD_DEBOUNCE_MS);
}

// =====================
// CONTROL PANEL
// =====================
function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(String(userId));
}

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle("🛠️ Beaver Falls Control Panel")
    .setDescription("Reset weekly boards to **0** (starts new week from now).")
    .addFields(
      { name: "Ranch Board", value: `<#${RANCH_OUTPUT_CHANNEL_ID}>`, inline: true },
      { name: "Camp Board", value: `<#${CAMP_OUTPUT_CHANNEL_ID}>`, inline: true }
    )
    .setFooter({ text: "Admin-only controls via ADMIN_USER_IDS." });
}

function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("reset_ranch").setLabel("Reset Ranch").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("reset_camp").setLabel("Reset Camp").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("reset_all").setLabel("Reset Both").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("refresh_all").setLabel("Refresh Boards").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function ensureControlPanel() {
  const msg = await ensureSingleMessage(CONTROL_CHANNEL_ID, "control_panel_msg", "Loading control panel…", {
    embeds: [panelEmbed()],
    components: panelRows(),
  });
  await msg.edit({ content: "", embeds: [panelEmbed()], components: panelRows() });
}

// Buttons
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    await interaction.deferReply({ ephemeral: true });

    if (!isAdmin(interaction.user.id)) {
      return interaction.editReply("❌ Not authorized.");
    }

    if (interaction.customId === "reset_ranch" || interaction.customId === "reset_all") {
      await setState("ranch_week_start", new Date().toISOString());
      await scheduleRanchUpdate();
    }

    if (interaction.customId === "reset_camp" || interaction.customId === "reset_all") {
      await setState("camp_week_start", new Date().toISOString());
      await scheduleCampUpdate();
    }

    if (interaction.customId === "refresh_all") {
      await scheduleRanchUpdate();
      await scheduleCampUpdate();
    }

    return interaction.editReply("✅ Done.");
  } catch (e) {
    try {
      if (interaction.deferred) await interaction.editReply(`❌ Error: ${e?.message || e}`);
    } catch {}
  }
});

// =====================
// POLL / BACKFILL
// =====================
async function pollChannel(channelId, parser, insertFn, label) {
  const channel = await fetchChannel(channelId);
  const msgs = await channel.messages.fetch({ limit: 100 });

  let inserted = 0;
  for (const [, m] of msgs) {
    const content = (m.content || "").trim();
    if (!content) continue;

    const evt = parser(content);
    if (!evt) continue;

    try {
      await insertFn(m.id, evt, m.createdAt?.toISOString());
      inserted++;
    } catch {}
  }

  console.log(`${label} poll fetched=${msgs.size} inserted~=${inserted}`);
}

async function backfillOnce(channelId, parser, insertFn, label, maxMessages) {
  const channel = await fetchChannel(channelId);
  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (!batch.size) break;

    for (const [, m] of batch) {
      scanned++;
      lastId = m.id;

      const content = (m.content || "").trim();
      if (!content) continue;

      const evt = parser(content);
      if (!evt) continue;

      try {
        await insertFn(m.id, evt, m.createdAt?.toISOString());
        inserted++;
      } catch {}

      if (scanned >= maxMessages) break;
    }
  }

  console.log(`📥 ${label} backfill scanned=${scanned} inserted~=${inserted}`);
}

async function startLoops() {
  if (!(await getState("ranch_week_start"))) await setState("ranch_week_start", new Date().toISOString());
  if (!(await getState("camp_week_start"))) await setState("camp_week_start", new Date().toISOString());

  if (BACKFILL_ON_START) {
    console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
    await backfillOnce(RANCH_INPUT_CHANNEL_ID, parseRanchLog, insertRanchEvent, "RANCH", BACKFILL_MAX_MESSAGES);
    await backfillOnce(CAMP_INPUT_CHANNEL_ID, parseCampLog, insertCampEvent, "CAMP", BACKFILL_MAX_MESSAGES);
  }

  await scheduleRanchUpdate();
  await scheduleCampUpdate();

  setInterval(async () => {
    try {
      await pollChannel(RANCH_INPUT_CHANNEL_ID, parseRanchLog, insertRanchEvent, "RANCH");
      await pollChannel(CAMP_INPUT_CHANNEL_ID, parseCampLog, insertCampEvent, "CAMP");
      await scheduleRanchUpdate();
      await scheduleCampUpdate();
    } catch (e) {
      console.error("❌ Poll loop error:", e?.message || e);
    }
  }, POLL_EVERY_MS);
}

// =====================
// ADMIN HTTP (optional)
// =====================
app.get("/admin/reset", async (req, res) => {
  try {
    if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "bad key" });
    const scope = String(req.query.scope || "all");
    const now = new Date().toISOString();

    if (scope === "ranch" || scope === "all") await setState("ranch_week_start", now);
    if (scope === "camp" || scope === "all") await setState("camp_week_start", now);

    await scheduleRanchUpdate();
    await scheduleCampUpdate();

    res.json({ ok: true, scope, week_start: now });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =====================
// STARTUP
// =====================
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);
    await ensureTablesAndMigrate();

    await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", "🏆 Loading ranch board…");
    await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", "🏕️ Loading camp board…");

    await ensureControlPanel();
    await startLoops();

    console.log("✅ Running.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🚀 Web listening on ${PORT}`));
