import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();
const { Pool } = pg;

/* =========================================================
   ENV (uses YOUR Railway variable names)
========================================================= */
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DISCORD_TOKEN) {
  console.error("❌ Missing Railway variable: DISCORD_TOKEN");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ Missing Railway variable: DATABASE_URL");
  process.exit(1);
}

const DEBUG = String(process.env.debug || "false").toLowerCase() === "true";

// Channels (your vars)
const RANCH_INPUT_CHANNEL_ID =
  process.env.RANCH_INPUT_CHANNEL_ID ||
  process.env.INPUT_CHANNEL_ID ||
  process.env.CHANNEL_ID;

const RANCH_OUTPUT_CHANNEL_ID =
  process.env.RANCH_OUTPUT_CHANNEL_ID ||
  process.env.LEADERBOARD_CHANNEL_ID;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

if (!RANCH_INPUT_CHANNEL_ID || !RANCH_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing ranch channels: RANCH_INPUT_CHANNEL_ID / RANCH_OUTPUT_CHANNEL_ID");
  process.exit(1);
}
if (!CAMP_INPUT_CHANNEL_ID || !CAMP_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing camp channels: CAMP_INPUT_CHANNEL_ID / CAMP_OUTPUT_CHANNEL_ID");
  process.exit(1);
}

// Backfill + polling (your vars)
const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true").toLowerCase() === "true";
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 1000);
const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 3000);

// Weekly rollover schedule (optional vars; defaults set for Tampa time)
const WEEKLY_TZ = process.env.WEEKLY_ROLLOVER_TZ || "America/New_York"; // Tampa time
const WEEKLY_DOW = Number(process.env.WEEKLY_ROLLOVER_DOW ?? 6); // Sat (Sun=0)
const WEEKLY_HOUR = Number(process.env.WEEKLY_ROLLOVER_HOUR ?? 9); // 9 AM local default
const WEEKLY_MINUTE = Number(process.env.WEEKLY_ROLLOVER_MINUTE ?? 0);

// Ranch math
const EGGS_PRICE = 1.25;
const MILK_PRICE = 1.25;

// Cattle logic (your vars; used internally only — NOT displayed)
const CATTLE_BISON_DEDUCTION = Number(process.env.CATTLE_BISON_DEDUCTION || 400);
const CATTLE_DEFAULT_DEDUCTION = Number(process.env.CATTLE_DEFAULT_DEDUCTION || 300);

// Camp math
const CAMP_FEE_RATE = 0.30;
const PTS_MATERIAL = 2;
const PTS_DELIVERY = 3;
const PTS_SUPPLY = 1;

// Delivery tiers
const CAMP_DELIVERY_SMALL = Number(process.env.CAMP_DELIVERY_SMALL || 500);
const CAMP_DELIVERY_MED = Number(process.env.CAMP_DELIVERY_MED || 950);
const CAMP_DELIVERY_LARGE = Number(process.env.CAMP_DELIVERY_LARGE || 1500);

/* =========================================================
   DB + APP
========================================================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.get("/", (_, res) => res.status(200).send("Beaver Falls Manager ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

/* =========================================================
   DISCORD
========================================================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

/* =========================================================
   SCHEMA / STATE
========================================================= */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.ranch_events (
      id BIGSERIAL PRIMARY KEY,
      discord_message_id TEXT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      eggs INT NOT NULL DEFAULT 0,
      milk INT NOT NULL DEFAULT 0,
      herd_profit NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.ranch_totals (
      user_id BIGINT PRIMARY KEY,
      eggs INT NOT NULL DEFAULT 0,
      milk INT NOT NULL DEFAULT 0,
      herd_profit NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_events (
      id BIGSERIAL PRIMARY KEY,
      discord_message_id TEXT UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      materials INT NOT NULL DEFAULT 0,
      supplies INT NOT NULL DEFAULT 0,
      del_small INT NOT NULL DEFAULT 0,
      del_med INT NOT NULL DEFAULT 0,
      del_large INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_totals (
      user_id BIGINT PRIMARY KEY,
      materials INT NOT NULL DEFAULT 0,
      supplies INT NOT NULL DEFAULT 0,
      del_small INT NOT NULL DEFAULT 0,
      del_med INT NOT NULL DEFAULT 0,
      del_large INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Safe migrations if old schema exists
  await pool.query(`
    ALTER TABLE public.ranch_events
      ADD COLUMN IF NOT EXISTS eggs INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS milk INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS herd_profit NUMERIC NOT NULL DEFAULT 0;

    ALTER TABLE public.camp_events
      ADD COLUMN IF NOT EXISTS materials INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS supplies INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS del_small INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS del_med INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS del_large INT NOT NULL DEFAULT 0;
  `);
}

async function getState(key, fallback = null) {
  const { rows } = await pool.query(`SELECT value FROM public.bot_state WHERE key=$1 LIMIT 1`, [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setState(key, value) {
  await pool.query(
    `
    INSERT INTO public.bot_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,
    [key, String(value)]
  );
}

async function getBoardMessageId(key) {
  const { rows } = await pool.query(`SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`, [key]);
  return rows.length ? rows[0].message_id.toString() : null;
}

async function setBoardMessage(key, channelId, messageId) {
  await pool.query(
    `
    INSERT INTO public.bot_messages (key, channel_id, message_id, updated_at)
    VALUES ($1, $2::bigint, $3::bigint, NOW())
    ON CONFLICT (key)
    DO UPDATE SET channel_id=EXCLUDED.channel_id, message_id=EXCLUDED.message_id, updated_at=NOW()
    `,
    [key, channelId, messageId]
  );
}

/* =========================================================
   TEXT / DATE HELPERS
========================================================= */
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function extractAllText(message) {
  let text = (message.content || "").trim();
  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.author?.name) text += `\n${e.author.name}`;
      if (e.fields?.length) for (const f of e.fields) text += `\n${f.name}\n${f.value}`;
      if (e.footer?.text) text += `\n${e.footer.text}`;
    }
  }
  return text.trim();
}

function getUserId(message, text) {
  const first = message.mentions?.users?.first?.();
  if (first?.id) return first.id;

  const mention = text.match(/<@!?(\d{17,19})>/);
  if (mention) return mention[1];

  const atLine = text.match(/@\S+\s+(\d{17,19})\b/);
  if (atLine) return atLine[1];

  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEKLY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return obj;
}
function fmtDate(date) {
  const p = tzParts(date);
  return `${p.month}/${p.day}/${p.year}`;
}

function nowInTZParts() {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEKLY_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date());
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return obj;
}
function dowFromShort(short) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}

/* =========================================================
   PARSERS
========================================================= */
// Ranch parser: Eggs + Milk + Cattle Sale
function parseRanch(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const userId = getUserId(message, text);
  if (!userId) return null;

  let eggs = 0;
  let milk = 0;
  let herd_profit = 0;

  const eggsRegex = /Added\s+Eggs[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  const milkRegex = /Added\s+Milk[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;

  let m;
  while ((m = eggsRegex.exec(text)) !== null) eggs += Number(m[1] || 0);
  while ((m = milkRegex.exec(text)) !== null) milk += Number(m[1] || 0);

  // Cattle Sale: profit = sell - deduction (bison vs default)
  const sale = text.match(/sold\s+\d+\s+([A-Za-z]+)\s+for\s+([0-9]+(?:\.[0-9]+)?)\$/i);
  if (sale) {
    const animal = sale[1].toLowerCase();
    const sell = Number(sale[2]);
    const deduction = animal.includes("bison") ? CATTLE_BISON_DEDUCTION : CATTLE_DEFAULT_DEDUCTION;
    herd_profit += (sell - deduction);
  }

  if (eggs === 0 && milk === 0 && herd_profit === 0) return null;
  return { userId, eggs, milk, herd_profit };
}

// Camp parser: Supplies + Materials + Deliveries (by sale value)
function parseCamp(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const userId = getUserId(message, text);
  if (!userId) return null;

  let materials = 0;
  let supplies = 0;
  let del_small = 0;
  let del_med = 0;
  let del_large = 0;

  const s = text.match(/Delivered\s+Supplies:\s*(\d+)/i);
  if (s) supplies += Number(s[1] || 0);

  const mats = text.match(/Materials\s+added:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (mats) materials += Math.floor(Number(mats[1] || 0));

  const sale = text.match(/Made\s+a\s+Sale\s+Of\s+\d+\s+Of\s+Stock\s+For\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
  if (sale) {
    const amt = Math.round(Number(sale[1] || 0));
    if (amt === CAMP_DELIVERY_LARGE) del_large++;
    else if (amt === CAMP_DELIVERY_MED) del_med++;
    else if (amt === CAMP_DELIVERY_SMALL) del_small++;
  }

  if (materials === 0 && supplies === 0 && del_small === 0 && del_med === 0 && del_large === 0) return null;
  return { userId, materials, supplies, del_small, del_med, del_large };
}

/* =========================================================
   INSERTS + TOTAL REBUILDS
========================================================= */
async function insertRanchEvent(msgId, d) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events (discord_message_id, user_id, eggs, milk, herd_profit)
    VALUES ($1, $2::bigint, $3::int, $4::int, $5::numeric)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [msgId, d.userId, d.eggs, d.milk, d.herd_profit]
  );
  return rowCount > 0;
}

async function insertCampEvent(msgId, d) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.camp_events (discord_message_id, user_id, materials, supplies, del_small, del_med, del_large)
    VALUES ($1, $2::bigint, $3::int, $4::int, $5::int, $6::int, $7::int)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [msgId, d.userId, d.materials, d.supplies, d.del_small, d.del_med, d.del_large]
  );
  return rowCount > 0;
}

async function rebuildRanchTotals() {
  await pool.query(`TRUNCATE public.ranch_totals`);
  await pool.query(`
    INSERT INTO public.ranch_totals (user_id, eggs, milk, herd_profit, updated_at)
    SELECT user_id,
      COALESCE(SUM(eggs),0)::int,
      COALESCE(SUM(milk),0)::int,
      COALESCE(SUM(herd_profit),0)::numeric,
      NOW()
    FROM public.ranch_events
    GROUP BY user_id
  `);
}

async function rebuildCampTotals() {
  await pool.query(`TRUNCATE public.camp_totals`);
  await pool.query(`
    INSERT INTO public.camp_totals (user_id, materials, supplies, del_small, del_med, del_large, updated_at)
    SELECT user_id,
      COALESCE(SUM(materials),0)::int,
      COALESCE(SUM(supplies),0)::int,
      COALESCE(SUM(del_small),0)::int,
      COALESCE(SUM(del_med),0)::int,
      COALESCE(SUM(del_large),0)::int,
      NOW()
    FROM public.camp_events
    GROUP BY user_id
  `);
}

/* =========================================================
   RENDER BOARDS (STATIC MESSAGE EDIT)
========================================================= */
async function ensureCurrentBoardMessage(boardKey, channelId, fallbackText) {
  const channel = await client.channels.fetch(channelId);
  let msgId = await getBoardMessageId(boardKey);

  if (!msgId) {
    const msg = await channel.send({ content: fallbackText });
    await setBoardMessage(boardKey, channelId, msg.id);
    return msg.id;
  }

  try {
    await channel.messages.fetch(msgId);
    return msgId;
  } catch {
    const msg = await channel.send({ content: fallbackText });
    await setBoardMessage(boardKey, channelId, msg.id);
    return msg.id;
  }
}

async function renderRanchBoard(isFinal = false) {
  const boardKey = "ranch_current_msg";
  const msgId = await ensureCurrentBoardMessage(
    boardKey,
    RANCH_OUTPUT_CHANNEL_ID,
    "🏆 **Beaver Falls — Weekly Ranch Ledger**\n\n(loading...)"
  );

  const channel = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, eggs, milk, herd_profit
    FROM public.ranch_totals
    WHERE eggs>0 OR milk>0 OR herd_profit<>0
  `);

  const players = rows
    .map(r => {
      const eggs = Number(r.eggs);
      const milk = Number(r.milk);
      const herdProfit = Number(r.herd_profit); // internal only
      const payout = eggs * EGGS_PRICE + milk * MILK_PRICE + herdProfit;
      return { user_id: r.user_id.toString(), eggs, milk, payout };
    })
    .sort((a, b) => b.payout - a.payout);

  const weekStartIso = await getState("ranch_week_start_iso", null);
  const weekStart = weekStartIso ? new Date(weekStartIso) : new Date();
  const now = new Date();
  const titleRange = `${fmtDate(weekStart)}–${fmtDate(now)}`;

  let out = `🏆 **Beaver Falls — Weekly Ranch Ledger${isFinal ? " (FINAL)" : ""}**\n`;
  out += `📅 ${titleRange}\n`;
  out += `🥚$${EGGS_PRICE} • 🥛$${MILK_PRICE}\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  const max = 80;

  for (let i = 0; i < Math.min(players.length, max); i++) {
    const p = players[i];
    const rank = medals[i] || `#${i + 1}`;
    // ✅ no profit column shown
    out += `${rank} <@${p.user_id}> | 🥚${p.eggs} 🥛${p.milk} | 💰 **${money(p.payout)}**\n`;
  }

  const payroll = players.reduce((a, p) => a + p.payout, 0);
  out += `\n---\n💼 **Total Ranch Payroll:** ${money(payroll)}`;

  await msg.edit({ content: out, embeds: [] });
}

function campMathRow(r) {
  const materials = Number(r.materials);
  const supplies = Number(r.supplies);
  const ds = Number(r.del_small);
  const dm = Number(r.del_med);
  const dl = Number(r.del_large);
  const deliveries = ds + dm + dl;

  const deliveryValue = ds * CAMP_DELIVERY_SMALL + dm * CAMP_DELIVERY_MED + dl * CAMP_DELIVERY_LARGE;
  const points = materials * PTS_MATERIAL + supplies * PTS_SUPPLY + deliveries * PTS_DELIVERY;

  return { materials, supplies, ds, dm, dl, deliveries, deliveryValue, points };
}

async function renderCampBoard(isFinal = false) {
  const boardKey = "camp_current_msg";
  const msgId = await ensureCurrentBoardMessage(
    boardKey,
    CAMP_OUTPUT_CHANNEL_ID,
    "🏕️ **Beaver Falls Camp — Weekly Payout (Points)**\n\n(loading...)"
  );

  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, materials, supplies, del_small, del_med, del_large
    FROM public.camp_totals
    WHERE materials>0 OR supplies>0 OR del_small>0 OR del_med>0 OR del_large>0
  `);

  const players = rows.map(r => ({ user_id: r.user_id.toString(), ...campMathRow(r) }));

  const totalDeliveryValue = players.reduce((a, p) => a + p.deliveryValue, 0);
  const totalPoints = players.reduce((a, p) => a + p.points, 0);

  const playerPool = totalDeliveryValue * (1 - CAMP_FEE_RATE);
  const campRevenue = totalDeliveryValue * CAMP_FEE_RATE;
  const valuePerPoint = totalPoints > 0 ? playerPool / totalPoints : 0;

  const ranked = players
    .map(p => ({ ...p, payout: p.points * valuePerPoint }))
    .sort((a, b) => b.payout - a.payout);

  const weekStartIso = await getState("camp_week_start_iso", null);
  const weekStart = weekStartIso ? new Date(weekStartIso) : new Date();
  const now = new Date();
  const titleRange = `${fmtDate(weekStart)}–${fmtDate(now)}`;

  // ✅ Compact one-line per player (no scrolling blocks)
  let out = `🏕️ **Beaver Falls Camp — Weekly Payout (Points)${isFinal ? " (FINAL)" : ""}**\n`;
  out += `📅 ${titleRange}\n`;
  out += `Fee: ${(CAMP_FEE_RATE * 100).toFixed(0)}% • Value/pt: ${money(valuePerPoint)}\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  const max = 60;

  for (let i = 0; i < Math.min(ranked.length, max); i++) {
    const p = ranked[i];
    const rank = medals[i] || `#${i + 1}`;
    out += `${rank} <@${p.user_id}> | 🪨${p.materials} 🚚${p.deliveries}(S${p.ds}/M${p.dm}/L${p.dl}) 📦${p.supplies} | ⭐${p.points} | 💰 **${money(p.payout)}**\n`;
  }

  out += `\n---\n🧾 Total Delivery: ${money(totalDeliveryValue)} • 💰 Camp Revenue: ${money(campRevenue)} • ⭐ Total Points: ${totalPoints}`;

  await msg.edit({ content: out, embeds: [] });
}

/* =========================================================
   POLLING + BACKFILL
========================================================= */
let ranchDebounce = null;
let campDebounce = null;

function scheduleRanchRender() {
  if (ranchDebounce) return;
  ranchDebounce = setTimeout(async () => {
    ranchDebounce = null;
    await rebuildRanchTotals();
    await renderRanchBoard(false);
  }, LEADERBOARD_DEBOUNCE_MS);
}

function scheduleCampRender() {
  if (campDebounce) return;
  campDebounce = setTimeout(async () => {
    campDebounce = null;
    await rebuildCampTotals();
    await renderCampBoard(false);
  }, LEADERBOARD_DEBOUNCE_MS);
}

async function pollOnce(channelId, parseFn, insertFn, label) {
  const channel = await client.channels.fetch(channelId);
  const batch = await channel.messages.fetch({ limit: 100 });

  let inserted = 0;
  for (const msg of batch.values()) {
    const d = parseFn(msg);
    if (!d) continue;
    const ok = await insertFn(msg.id, d);
    if (ok) inserted++;
  }

  if (DEBUG) console.log(`${label} poll fetched=${batch.size} inserted=${inserted}`);
  return inserted;
}

async function backfillChannel(channelId, parseFn, insertFn, label) {
  const channel = await client.channels.fetch(channelId);

  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < BACKFILL_MAX_MESSAGES) {
    const limit = Math.min(100, BACKFILL_MAX_MESSAGES - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit, before: lastId } : { limit });
    if (!batch.size) break;

    const msgs = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const msg of msgs) {
      scanned++;
      const d = parseFn(msg);
      if (!d) continue;
      const ok = await insertFn(msg.id, d);
      if (ok) inserted++;
    }
    lastId = msgs[0].id;
  }

  console.log(`📥 ${label} backfill scanned=${scanned} inserted=${inserted}`);
  return inserted;
}

/* =========================================================
   WEEKLY ROLLOVER (AUTO ARCHIVE + RESET)
========================================================= */
async function initWeekStartsIfMissing() {
  const r = await getState("ranch_week_start_iso", null);
  if (!r) await setState("ranch_week_start_iso", new Date().toISOString());

  const c = await getState("camp_week_start_iso", null);
  if (!c) await setState("camp_week_start_iso", new Date().toISOString());
}

async function rolloverIfDue() {
  const p = nowInTZParts();
  const dow = dowFromShort(p.weekday);
  const hh = Number(p.hour);
  const mm = Number(p.minute);

  if (dow !== WEEKLY_DOW) return;
  if (hh !== WEEKLY_HOUR || mm !== WEEKLY_MINUTE) return;

  // Once per calendar day in TZ
  const stamp = `${p.year}-${p.month}-${p.day}`;
  const last = await getState("weekly_rollover_stamp", "");
  if (last === stamp) return;

  console.log(`🗓️ Weekly rollover triggered (${stamp} ${WEEKLY_TZ})`);

  // 1) Mark current boards FINAL with date range + final payouts
  await rebuildRanchTotals();
  await rebuildCampTotals();
  await renderRanchBoard(true);
  await renderCampBoard(true);

  // 2) Post NEW current-week messages (archives old week automatically)
  {
    const ranchOut = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
    const newMsg = await ranchOut.send({
      content: "🏆 **Beaver Falls — Weekly Ranch Ledger**\n\n(Starting new week…)",
    });
    await setBoardMessage("ranch_current_msg", RANCH_OUTPUT_CHANNEL_ID, newMsg.id);
  }
  {
    const campOut = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
    const newMsg = await campOut.send({
      content: "🏕️ **Beaver Falls Camp — Weekly Payout (Points)**\n\n(Starting new week…)",
    });
    await setBoardMessage("camp_current_msg", CAMP_OUTPUT_CHANNEL_ID, newMsg.id);
  }

  // 3) Zero out weekly tables
  await pool.query(`TRUNCATE public.ranch_events`);
  await pool.query(`TRUNCATE public.ranch_totals`);
  await pool.query(`TRUNCATE public.camp_events`);
  await pool.query(`TRUNCATE public.camp_totals`);

  // 4) New week start stamps
  const nowIso = new Date().toISOString();
  await setState("ranch_week_start_iso", nowIso);
  await setState("camp_week_start_iso", nowIso);

  // 5) Render empty fresh boards
  await renderRanchBoard(false);
  await renderCampBoard(false);

  // 6) Save stamp so it doesn’t trigger twice
  await setState("weekly_rollover_stamp", stamp);

  console.log("✅ Weekly rollover complete (FINAL archived, new posts created, stats reset)");
}

/* =========================================================
   STARTUP
========================================================= */
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);

    await ensureSchema();
    await initWeekStartsIfMissing();

    // Ensure current board messages exist & render once
    await renderRanchBoard(false);
    await renderCampBoard(false);

    // Backfill (pull history into current week)
    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
      const rInserted = await backfillChannel(RANCH_INPUT_CHANNEL_ID, parseRanch, insertRanchEvent, "RANCH");
      const cInserted = await backfillChannel(CAMP_INPUT_CHANNEL_ID, parseCamp, insertCampEvent, "CAMP");
      if (rInserted > 0) scheduleRanchRender();
      if (cInserted > 0) scheduleCampRender();
    }

    // Poll loops (no spam; just edits the existing board)
    setInterval(async () => {
      try {
        const r = await pollOnce(RANCH_INPUT_CHANNEL_ID, parseRanch, insertRanchEvent, "RANCH");
        if (r > 0) scheduleRanchRender();
      } catch (e) {
        console.error("❌ Ranch poll error:", e);
      }
    }, BACKFILL_EVERY_MS);

    setInterval(async () => {
      try {
        const c = await pollOnce(CAMP_INPUT_CHANNEL_ID, parseCamp, insertCampEvent, "CAMP");
        if (c > 0) scheduleCampRender();
      } catch (e) {
        console.error("❌ Camp poll error:", e);
      }
    }, BACKFILL_EVERY_MS);

    // Weekly rollover checker (every 30s)
    setInterval(() => {
      rolloverIfDue().catch(e => console.error("❌ rolloverIfDue error:", e));
    }, 30_000);

    console.log(
      `✅ Running. Poll=${BACKFILL_EVERY_MS}ms | Weekly reset: Sat ${String(WEEKLY_HOUR).padStart(2, "0")}:${String(
        WEEKLY_MINUTE
      ).padStart(2, "0")} ${WEEKLY_TZ}`
    );
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

/* =========================================================
   SHUTDOWN
========================================================= */
async function shutdown(signal) {
  console.log(`🛑 ${signal} received. Shutting down...`);
  try {
    await client.destroy().catch(() => {});
    await pool.end().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  } catch {
    process.exit(1);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.login(DISCORD_TOKEN);
