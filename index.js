import express from "express";
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import pg from "pg";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // you use DISCORD_TOKEN (not BOT_TOKEN)
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

const HERD_QUEUE_CHANNEL_ID = process.env.HERD_QUEUE_CHANNEL_ID; // existing (not used here)

const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID; // NEW
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 1000);
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 2000);

const RANCH_NAME = process.env.RANCH_NAME || "Beaver Falls";
const CAMP_NAME = process.env.CAMP_NAME || "Beaver Falls Camp";

// Prices
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
// DB TABLES (state + events)
// =====================
async function ensureTables() {
  // Store message IDs + week_start cutoffs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Minimal ranch events table (message-based ingestion). Adjust if your schema differs.
  // We keep it flexible so inserts don’t fail on missing columns.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranch_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,              -- 'eggs' | 'milk' | 'cattle_sale'
      qty NUMERIC NOT NULL DEFAULT 0,  -- eggs/milk counts OR animals sold
      amount NUMERIC NOT NULL DEFAULT 0, -- money value for cattle sales (if you track)
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS camp_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,               -- 'materials' | 'supplies' | 'delivery_small' | 'delivery_med' | 'delivery_large'
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0, -- delivery value if you store it
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
// WEEK START LOGIC
// Reset = set week_start to now
// =====================
async function setWeekStartNow(scope) {
  const nowIso = new Date().toISOString();
  if (scope === "ranch" || scope === "all") await setState("ranch_week_start", nowIso);
  if (scope === "camp" || scope === "all") await setState("camp_week_start", nowIso);
  return nowIso;
}

// =====================
// DISCORD MESSAGE HELPERS
// =====================
async function fetchChannel(channelId) {
  const ch = await client.channels.fetch(channelId);
  if (!ch) throw new Error(`Channel not found: ${channelId}`);
  return ch;
}

async function ensureSingleMessage(channelId, stateKey, initialContent = "Loading…", messageOptions = {}) {
  const ch = await fetchChannel(channelId);
  let msgId = await getState(stateKey);

  if (msgId) {
    try {
      const msg = await ch.messages.fetch(msgId);
      return msg;
    } catch {
      // If deleted, create again
    }
  }

  const msg = await ch.send({ content: initialContent, ...messageOptions });
  await setState(stateKey, msg.id);
  return msg;
}

// =====================
// PARSING (simple & tolerant)
// You already have richer parsing — keep yours if you want.
// These regexes match examples you pasted.
// =====================
function parseRanchLog(messageContent) {
  // Eggs Added ... : 33
  // Milk Added ... : 39
  // Cattle Sale ... sold 5 Bison for 1200.0$
  // We'll extract user_id from <@id> or "Discord: @name id" style
  const userIdMatch =
    messageContent.match(/<@(\d{15,20})>/) ||
    messageContent.match(/Discord:\s*@.*?(\d{15,20})/);

  const user_id = userIdMatch ? BigInt(userIdMatch[1]) : null;

  // Eggs / Milk
  const eggsMatch = messageContent.match(/Added Eggs.*?:\s*(\d+)/i);
  if (user_id && eggsMatch) return { user_id, kind: "eggs", qty: Number(eggsMatch[1]), amount: 0 };

  const milkMatch = messageContent.match(/Added Milk.*?:\s*(\d+)/i);
  if (user_id && milkMatch) return { user_id, kind: "milk", qty: Number(milkMatch[1]), amount: 0 };

  // Cattle Sale: "sold 5 Bison for 1200.0$"
  const saleMatch = messageContent.match(/sold\s+(\d+)\s+([A-Za-z ]+)\s+for\s+([\d.]+)\$/i);
  if (user_id && saleMatch) {
    const animals = Number(saleMatch[1]);
    const value = Number(saleMatch[3]);
    return { user_id, kind: "cattle_sale", qty: animals, amount: value };
  }

  return null;
}

function parseCampLog(messageContent) {
  // Examples:
  // "Delivered Supplies: 42"
  // "Donated ... / Materials added: 1.0"
  // "Made a Sale Of 100 Of Stock For $1900"
  const userIdMatch =
    messageContent.match(/Discord:\s*@.*?(\d{15,20})/i) ||
    messageContent.match(/<@(\d{15,20})>/);

  const user_id = userIdMatch ? BigInt(userIdMatch[1]) : null;
  if (!user_id) return null;

  const supplies = messageContent.match(/Delivered Supplies:\s*(\d+)/i);
  if (supplies) return { user_id, kind: "supplies", qty: Number(supplies[1]), amount: 0 };

  const mats = messageContent.match(/Materials added:\s*([\d.]+)/i);
  if (mats) return { user_id, kind: "materials", qty: Number(mats[1]), amount: 0 };

  // Delivery tiers (you said large=1500 med=950 small=500)
  // If your logs expose it (small/med/large), wire it here later.
  const sale = messageContent.match(/Made a Sale Of\s+(\d+)\s+Of Stock For\s+\$?([\d.]+)/i);
  if (sale) {
    // Treat as a "delivery" value for now (amount=money, qty=1)
    return { user_id, kind: "delivery", qty: 1, amount: Number(sale[2]) };
  }

  return null;
}

// =====================
// INSERTS (idempotent by source_message_id)
// =====================
async function insertRanchEvent(source_message_id, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO ranch_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id) DO NOTHING
    `,
    [
      String(source_message_id),
      String(evt.user_id),
      evt.kind,
      evt.qty,
      evt.amount,
      createdAtIso || new Date().toISOString(),
    ]
  );
}

async function insertCampEvent(source_message_id, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO camp_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id) DO NOTHING
    `,
    [
      String(source_message_id),
      String(evt.user_id),
      evt.kind,
      evt.qty,
      evt.amount,
      createdAtIso || new Date().toISOString(),
    ]
  );
}

// =====================
// BUILD LEADERBOARDS (compact + badges)
// NOTE: We show @mention only (no raw IDs).
// =====================
function formatMoney(n) {
  return `$${Number(n).toFixed(2)}`;
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
    GROUP BY user_id
    `,
    [weekStartIso]
  );

  const users = rows.map((r) => {
    const eggs = Number(r.eggs || 0);
    const milk = Number(r.milk || 0);
    const animals_sold = Number(r.animals_sold || 0);
    const cattle_value = Number(r.cattle_value || 0);

    const payout = eggs * PRICE_EGGS + milk * PRICE_MILK + cattle_value; // adjust if you use deductions/profits elsewhere
    return {
      user_id: r.user_id,
      eggs,
      milk,
      animals_sold,
      cattle_value,
      payout,
    };
  });

  users.sort((a, b) => b.payout - a.payout);
  return users;
}

async function renderRanchBoard() {
  const weekStartIso = (await getState("ranch_week_start")) || new Date().toISOString();
  const users = await ranchTotalsSince(weekStartIso);

  const totalMilk = users.reduce((a, u) => a + u.milk, 0);
  const totalEggs = users.reduce((a, u) => a + u.eggs, 0);
  const totalPayout = users.reduce((a, u) => a + u.payout, 0);
  const totalAnimals = users.reduce((a, u) => a + u.animals_sold, 0);

  const lines = [];
  lines.push(`🏆 **${RANCH_NAME} Ranch — Weekly Ledger**`);
  lines.push(`📅 Since: **${new Date(weekStartIso).toLocaleString("en-US", { timeZone: "America/New_York" })} ET**`);
  lines.push(`🥛 **${totalMilk.toLocaleString()}** • 🥚 **${totalEggs.toLocaleString()}** • 🐄 **Sold: ${totalAnimals.toLocaleString()}**`);
  lines.push(`💰 **Total Ranch Payout:** ${formatMoney(totalPayout)}`);
  lines.push("");

  const badge = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`);
  const max = Math.min(users.length, 25); // compact - show top 25

  for (let i = 0; i < max; i++) {
    const u = users[i];
    const mention = `<@${u.user_id}>`;
    lines.push(
      `${badge(i)} ${mention} — 🥛${u.milk} 🥚${u.eggs} 🐄${u.animals_sold} — **${formatMoney(u.payout)}**`
    );
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
    GROUP BY user_id
    `,
    [weekStartIso]
  );

  // Points system: supplies=1 pt, materials=2 pts (if you count "sets"), deliveries=3 pts
  // You can tweak later — this keeps your existing vibe.
  const users = rows.map((r) => {
    const materials = Number(r.materials || 0);
    const supplies = Number(r.supplies || 0);
    const deliveries = Number(r.deliveries || 0);
    const delivery_value = Number(r.delivery_value || 0);

    const points = materials * 2 + supplies * 1 + deliveries * 3;
    // payout pool is 70% of delivery_value? (30% camp cut) — plus you might add materials/supplies pool later.
    // For now, just show points and delivery value.
    const payout = delivery_value * 0.7; // adjust later when you finalize tiers
    return { user_id: r.user_id, materials, supplies, deliveries, delivery_value, points, payout };
  });

  users.sort((a, b) => b.payout - a.payout);
  return users;
}

async function renderCampBoard() {
  const weekStartIso = (await getState("camp_week_start")) || new Date().toISOString();
  const users = await campTotalsSince(weekStartIso);

  const totalPoints = users.reduce((a, u) => a + u.points, 0);
  const totalDelivery = users.reduce((a, u) => a + u.delivery_value, 0);
  const campRevenue = totalDelivery * 0.3;
  const totalPayout = users.reduce((a, u) => a + u.payout, 0);

  const lines = [];
  lines.push(`🏕️ **${CAMP_NAME} — Weekly Ledger**`);
  lines.push(`📅 Since: **${new Date(weekStartIso).toLocaleString("en-US", { timeZone: "America/New_York" })} ET**`);
  lines.push(`Payout Mode: **Points (30% camp fee)**`);
  lines.push(`🧾 Delivery Value: **${formatMoney(totalDelivery)}** • 🪙 Camp Revenue: **${formatMoney(campRevenue)}**`);
  lines.push(`⭐ Total Points: **${totalPoints.toLocaleString()}** • 💰 Player Payouts: **${formatMoney(totalPayout)}**`);
  lines.push("");

  const badge = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`);
  const max = Math.min(users.length, 25);

  for (let i = 0; i < max; i++) {
    const u = users[i];
    const mention = `<@${u.user_id}>`;
    lines.push(
      `${badge(i)} ${mention} — 🪨${u.materials} 📦${u.supplies} 🚚${u.deliveries} ⭐${u.points} — **${formatMoney(u.payout)}**`
    );
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
// CONTROL PANEL (Embed + Reset buttons)
// =====================
function isAdminUser(userId) {
  return ADMIN_USER_IDS.includes(String(userId));
}

function controlPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🛠️ Beaver Falls Control Panel")
    .setDescription(
      [
        "Use these buttons to reset the live weekly tables to **0**.",
        "",
        "✅ Reset does **not** delete history in Postgres — it just starts a new week from **now**.",
        "Only admins listed in `ADMIN_USER_IDS` can use these buttons.",
      ].join("\n")
    )
    .addFields(
      { name: "Ranch Board", value: `<#${RANCH_OUTPUT_CHANNEL_ID}>`, inline: true },
      { name: "Camp Board", value: `<#${CAMP_OUTPUT_CHANNEL_ID}>`, inline: true },
      { name: "Controls", value: "Reset Ranch / Reset Camp / Reset Both", inline: false }
    )
    .setFooter({ text: "If you ever see 'Interaction failed', check bot permissions + ensure only 1 Railway instance." });
}

function controlPanelComponents() {
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
  const msg = await ensureSingleMessage(
    CONTROL_CHANNEL_ID,
    "control_panel_msg",
    "Loading control panel…",
    {
      embeds: [controlPanelEmbed()],
      components: controlPanelComponents(),
    }
  );

  // If it exists, keep it updated (in case IDs change)
  await msg.edit({
    content: "",
    embeds: [controlPanelEmbed()],
    components: controlPanelComponents(),
  });

  return msg;
}

// =====================
// POLL / BACKFILL FROM LOG CHANNELS
// (Reads latest messages, inserts events, updates boards)
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

    // Insert with message id as dedupe key
    const before = Date.now();
    try {
      await insertFn(m.id, evt, m.createdAt?.toISOString());
      inserted++;
    } catch (e) {
      // ignore dupes/errors but print in debug
      if (String(process.env.debug || "false") === "true") {
        console.log(`⚠️ ${label} insert failed for msg ${m.id}:`, e?.message || e);
      }
    }

    // tiny yield for rate safety
    if (Date.now() - before > 50) await new Promise((r) => setTimeout(r, 5));
  }

  if (String(process.env.debug || "false") === "true") {
    console.log(`${label} poll fetched=${msgs.size} inserted~=${inserted}`);
  }
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
      } catch {
        // ignore dupes
      }

      if (scanned >= maxMessages) break;
    }
  }

  console.log(`📥 ${label} backfill scanned=${scanned} inserted~=${inserted}`);
}

async function startPollingLoop() {
  // On startup, ensure week_start exists (otherwise set now)
  if (!(await getState("ranch_week_start"))) await setState("ranch_week_start", new Date().toISOString());
  if (!(await getState("camp_week_start"))) await setState("camp_week_start", new Date().toISOString());

  if (BACKFILL_ON_START) {
    console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
    await backfillOnce(RANCH_INPUT_CHANNEL_ID, parseRanchLog, insertRanchEvent, "RANCH", BACKFILL_MAX_MESSAGES);
    await backfillOnce(CAMP_INPUT_CHANNEL_ID, parseCampLog, insertCampEvent, "CAMP", BACKFILL_MAX_MESSAGES);
  }

  // initial render
  await scheduleRanchUpdate();
  await scheduleCampUpdate();

  // loop
  setInterval(async () => {
    try {
      await pollChannel(RANCH_INPUT_CHANNEL_ID, parseRanchLog, insertRanchEvent, "RANCH");
      await pollChannel(CAMP_INPUT_CHANNEL_ID, parseCampLog, insertCampEvent, "CAMP");
      await scheduleRanchUpdate();
      await scheduleCampUpdate();
    } catch (e) {
      console.error("❌ Poll loop error:", e?.message || e);
    }
  }, BACKFILL_EVERY_MS);
}

// =====================
// INTERACTIONS (RESET BUTTONS)
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    // Always ack quickly so it never shows "Interaction failed"
    await interaction.deferReply({ ephemeral: true });

    if (!isAdminUser(interaction.user.id)) {
      return interaction.editReply("❌ You are not authorized to use these controls.");
    }

    if (interaction.customId === "reset_ranch") {
      const iso = await setWeekStartNow("ranch");
      await scheduleRanchUpdate();
      return interaction.editReply(`✅ Ranch reset to 0. New week started at: ${iso}`);
    }

    if (interaction.customId === "reset_camp") {
      const iso = await setWeekStartNow("camp");
      await scheduleCampUpdate();
      return interaction.editReply(`✅ Camp reset to 0. New week started at: ${iso}`);
    }

    if (interaction.customId === "reset_all") {
      const iso = await setWeekStartNow("all");
      await scheduleRanchUpdate();
      await scheduleCampUpdate();
      return interaction.editReply(`✅ Ranch + Camp reset to 0. New week started at: ${iso}`);
    }

    if (interaction.customId === "refresh_all") {
      await scheduleRanchUpdate();
      await scheduleCampUpdate();
      return interaction.editReply("🔄 Refreshed ranch + camp boards.");
    }

    return interaction.editReply("Unknown button.");
  } catch (e) {
    try {
      if (interaction.deferred) await interaction.editReply(`❌ Error: ${e?.message || e}`);
    } catch {}
  }
});

// =====================
// ADMIN HTTP (optional)
// =====================
app.get("/admin/reset", async (req, res) => {
  try {
    if (req.query.key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: "bad key" });
    const scope = String(req.query.scope || "all");
    const iso = await setWeekStartNow(scope);
    await scheduleRanchUpdate();
    await scheduleCampUpdate();
    res.json({ ok: true, scope, week_start: iso });
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

    await ensureTables();

    // Ensure boards exist (single static messages)
    await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", "🏆 Loading ranch board…");
    await ensureSingleMessage(CAMP_OUTPUT_CHANNEL_ID, "camp_board_msg", "🏕️ Loading camp board…");

    // Control panel
    await ensureControlPanel();

    // Start polling/log ingestion
    await startPollingLoop();

    console.log("✅ Running.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN);

app.listen(PORT, () => console.log(`🚀 Web listening on ${PORT}`));
