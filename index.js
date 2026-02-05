import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

dotenv.config();
const { Pool } = pg;

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 8080;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || null;

const CAMP_SYNC_FROM_ATTACHMENTS = (process.env.CAMP_SYNC_FROM_ATTACHMENTS || "true") === "true";
const CAMP_ATTACH_SCAN_LIMIT = Number(process.env.CAMP_ATTACH_SCAN_LIMIT || 50);

// Delivery values
const DELIVERY_VALUES = {
  small: 500,
  medium: 950,
  large: 1500,
};

// 30% camp fee
const CAMP_CUT = 0.30;

// Points multipliers (confirmed)
const MATERIAL_POINTS = 2;
const DELIVERY_POINTS = 3;
const SUPPLY_POINTS = 1;

// =========================
// VALIDATE ENV
// =========================
function validateEnv() {
  const required = ["BOT_TOKEN", "DATABASE_URL", "CAMP_INPUT_CHANNEL_ID", "CAMP_OUTPUT_CHANNEL_ID"];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) {
    console.error(`❌ Missing Railway Variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}
validateEnv();

// =========================
// POSTGRES
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// =========================
// EXPRESS
// =========================
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.status(200).send("Camp Tracker Running ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

// =========================
// DISCORD
// =========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("error", (err) => console.error("❌ Discord client error:", err));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// =========================
// SCHEMA
// =========================
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.camp_events (
      id BIGSERIAL PRIMARY KEY,
      discord_message_id TEXT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      item TEXT NOT NULL CHECK (item IN ('materials','supplies','small','medium','large')),
      amount INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_totals (
      user_id BIGINT PRIMARY KEY,
      material_sets INT NOT NULL DEFAULT 0,
      supplies INT NOT NULL DEFAULT 0,
      small INT NOT NULL DEFAULT 0,
      medium INT NOT NULL DEFAULT 0,
      large INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_snapshot_files (
      message_id TEXT PRIMARY KEY,
      filename TEXT,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// =========================
// ADMIN CHECK
// =========================
function isAdminMember(interaction) {
  try {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (ADMIN_ROLE_ID && interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID)) return true;
  } catch {}
  return false;
}

// =========================
// STATIC MESSAGE
// =========================
let campMessageId = null;

async function ensureMessage() {
  const { rows } = await pool.query(
    "SELECT message_id FROM public.bot_messages WHERE key='camp_board' LIMIT 1"
  );

  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);

  if (rows.length) {
    try {
      await channel.messages.fetch(rows[0].message_id.toString());
      return rows[0].message_id.toString();
    } catch {}
  }

  const msg = await channel.send("🏕️ Baba Yaga Camp\nLoading...");
  await pool.query(
    `INSERT INTO public.bot_messages (key, channel_id, message_id, updated_at)
     VALUES ('camp_board',$1::bigint,$2::bigint,NOW())
     ON CONFLICT (key) DO UPDATE
     SET channel_id=EXCLUDED.channel_id, message_id=EXCLUDED.message_id, updated_at=NOW()`,
    [CAMP_OUTPUT_CHANNEL_ID, msg.id]
  );

  return msg.id;
}

// =========================
// POINTS / PAYOUT CALC
// =========================
function computePoints(p) {
  const deliveries = p.small + p.medium + p.large;
  return (p.material_sets * MATERIAL_POINTS) + (deliveries * DELIVERY_POINTS) + (p.supplies * SUPPLY_POINTS);
}

function computeTotalDeliveryValue(p) {
  return (p.small * DELIVERY_VALUES.small) +
         (p.medium * DELIVERY_VALUES.medium) +
         (p.large * DELIVERY_VALUES.large);
}

// =========================
// CAMP BOARD RENDER
// =========================
async function updateCampBoard() {
  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(campMessageId);

  const { rows } = await pool.query(
    `SELECT user_id, material_sets, supplies, small, medium, large
     FROM public.camp_totals
     WHERE material_sets>0 OR supplies>0 OR small>0 OR medium>0 OR large>0`
  );

  const players = rows.map((r) => {
    const p = {
      user_id: r.user_id,
      material_sets: Number(r.material_sets),
      supplies: Number(r.supplies),
      small: Number(r.small),
      medium: Number(r.medium),
      large: Number(r.large),
    };
    const deliveries = p.small + p.medium + p.large;
    const points = computePoints(p);
    const deliveryValue = computeTotalDeliveryValue(p);
    return { ...p, deliveries, points, deliveryValue };
  });

  const totalPoints = players.reduce((a, p) => a + p.points, 0);
  const totalDeliveryValue = players.reduce((a, p) => a + p.deliveryValue, 0);

  const playerPool = totalDeliveryValue * (1 - CAMP_CUT);
  const campRevenue = totalDeliveryValue * CAMP_CUT;
  const valuePerPoint = totalPoints > 0 ? playerPool / totalPoints : 0;

  players.sort((a, b) => b.points - a.points);

  const embed = new EmbedBuilder()
    .setTitle("🏕️ Baba Yaga Camp")
    .setDescription("Payout Mode: Points (30% camp fee)")
    .setColor(0x2b2d31);

  for (const p of players.slice(0, 24)) {
    const payout = p.points * valuePerPoint;

    const lines = [];
    lines.push(`🪨 Materials: ${p.material_sets}`);
    if (p.deliveries > 0) lines.push(`🚚 Deliveries: ${p.deliveries} (S:${p.small} M:${p.medium} L:${p.large})`);
    if (p.supplies > 0) lines.push(`📦 Supplies: ${p.supplies}`);
    lines.push(`⭐ Points: ${p.points}`);
    lines.push(`💰 Payout: **$${payout.toFixed(2)}**`);

    embed.addFields({
      name: `<@${p.user_id}>`,
      value: lines.join("\n"),
      inline: true,
    });
  }

  embed.setFooter({
    text: `🧾 Total Delivery Value: $${totalDeliveryValue.toFixed(0)} • 💰 Camp Revenue: $${campRevenue.toFixed(0)}`,
  });

  await msg.edit({ content: "", embeds: [embed] });
}

// =========================
// LIVE MESSAGE PARSER (existing)
// =========================
function parseMessage(message) {
  const text = (message.content || "").trim();
  if (!text) return null;

  const userMatch = text.match(/<@(\d+)>/);
  if (!userMatch) return null;
  const userId = userMatch[1];

  if (/material sets/i.test(text)) {
    const amt = Number(text.match(/(\d+)\s*material sets/i)?.[1] || 0);
    if (amt > 0) return { userId, item: "materials", amount: amt };
  }

  if (/\bsupplies\b/i.test(text)) {
    const amt = Number(text.match(/(\d+)\s*supplies/i)?.[1] || 0);
    if (amt > 0) return { userId, item: "supplies", amount: amt };
  }

  if (/small delivery/i.test(text)) return { userId, item: "small", amount: 1 };
  if (/medium delivery/i.test(text)) return { userId, item: "medium", amount: 1 };
  if (/large delivery/i.test(text)) return { userId, item: "large", amount: 1 };

  return null;
}

async function storeEvent({ userId, item, amount }, discordMessageId) {
  const result = await pool.query(
    `INSERT INTO public.camp_events (discord_message_id,user_id,item,amount)
     VALUES ($1,$2::bigint,$3,$4)
     ON CONFLICT (discord_message_id) DO NOTHING
     RETURNING id`,
    [discordMessageId, userId, item, amount]
  );

  if (!result.rowCount) return false;

  await pool.query(
    `INSERT INTO public.camp_totals (user_id)
     VALUES ($1::bigint)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const column = item === "materials" ? "material_sets" : item;

  await pool.query(
    `UPDATE public.camp_totals
     SET ${column}=${column}+$2,
         updated_at=NOW()
     WHERE user_id=$1::bigint`,
    [userId, amount]
  );

  return true;
}

// =========================
// ATTACHMENT SNAPSHOT SYNC
// =========================
function looksLikeSnapshotFilename(name = "") {
  const n = name.toLowerCase();
  return n.endsWith(".json") || n.endsWith(".csv") || n.endsWith(".txt");
}

function parseSnapshotContent(filename, raw) {
  const lower = filename.toLowerCase();

  // ---- JSON: supports array or object map
  if (lower.endsWith(".json")) {
    const data = JSON.parse(raw);

    // Case A: [{user_id, material_sets, supplies, small, medium, large}, ...]
    if (Array.isArray(data)) return data;

    // Case B: { "123": {material_sets:..}, "456": {...} }
    if (data && typeof data === "object") {
      return Object.entries(data).map(([user_id, v]) => ({ user_id, ...(v || {}) }));
    }
  }

  // ---- CSV: user_id,material_sets,supplies,small,medium,large
  if (lower.endsWith(".csv")) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = (k) => header.indexOf(k);

    return lines.slice(1).map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      const getNum = (k) => {
        const i = idx(k);
        if (i < 0) return 0;
       
