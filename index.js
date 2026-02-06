import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits } from "discord.js";

dotenv.config();
const { Pool } = pg;

// ===================== ENV (your Railway variable names) =====================
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ Missing Railway variable: DISCORD_TOKEN");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing Railway variable: DATABASE_URL");
  process.exit(1);
}

const DEBUG = String(process.env.debug || "false").toLowerCase() === "true";

// Ranch channels (your vars)
const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID || process.env.INPUT_CHANNEL_ID || process.env.CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID || process.env.LEADERBOARD_CHANNEL_ID;

// Camp channels (your vars)
const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

if (!RANCH_INPUT_CHANNEL_ID || !RANCH_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing ranch channel vars: RANCH_INPUT_CHANNEL_ID / RANCH_OUTPUT_CHANNEL_ID");
  process.exit(1);
}
if (!CAMP_INPUT_CHANNEL_ID || !CAMP_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing camp channel vars: CAMP_INPUT_CHANNEL_ID / CAMP_OUTPUT_CHANNEL_ID");
  process.exit(1);
}

// Backfill controls (your vars)
const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true").toLowerCase() === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 1000);
const BACKFILL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

// Leaderboard debounce (your var)
const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 3000);

// Weekly rollover (optional vars; defaults are fine)
const WEEKLY_ROLLOVER_DOW = Number(process.env.WEEKLY_ROLLOVER_DOW ?? 6); // Sat (Sun=0)
const WEEKLY_ROLLOVER_HOUR = Number(process.env.WEEKLY_ROLLOVER_HOUR ?? 16); // in TZ below
const WEEKLY_ROLLOVER_MINUTE = Number(process.env.WEEKLY_ROLLOVER_MINUTE ?? 0);
const WEEKLY_ROLLOVER_TZ = process.env.WEEKLY_ROLLOVER_TZ || "UTC";

// Ranch item prices
const MILK_PRICE = 1.25;
const EGGS_PRICE = 1.25;

// Cattle deductions (your vars; used to compute profit)
const CATTLE_BISON_DEDUCTION = Number(process.env.CATTLE_BISON_DEDUCTION || 400);
const CATTLE_DEFAULT_DEDUCTION = Number(process.env.CATTLE_DEFAULT_DEDUCTION || 300);

// Camp delivery values (you set large=1500, med=950, assume small=500)
const CAMP_DELIVERY_SMALL = Number(process.env.CAMP_DELIVERY_SMALL || 500);
const CAMP_DELIVERY_MED = Number(process.env.CAMP_DELIVERY_MED || 950);
const CAMP_DELIVERY_LARGE = Number(process.env.CAMP_DELIVERY_LARGE || 1500);

// Camp points weights (match other bot)
const CAMP_POINTS_MATERIAL = 2;
const CAMP_POINTS_DELIVERY = 3;
const CAMP_POINTS_SUPPLY = 1;
const CAMP_FEE_RATE = 0.30;

// ===================== DB =====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===================== EXPRESS =====================
const app = express();
app.get("/", (_, res) => res.status(200).send("Ranch + Camp Manager ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

// ===================== DISCORD =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ===================== SCHEMA + STATE =====================
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Stores the CURRENT message id that the bot edits for each board
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Weekly ranch events (dedupe by discord_message_id)
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

    -- Weekly camp events
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

async function getBoardMessageId(key) {
  const { rows } = await pool.query(`SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`, [key]);
  return rows.length ? rows[0].message_id.toString() : null;
}

// ===================== HELPERS =====================
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

// ===================== RANCH PARSE =====================
// Handles: Eggs Added, Milk Added (can be multiple in one msg), and Cattle Sale profit logic.
function parseRanch(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const userId = getUserId(message, text);
  if (!userId) return null;

  let eggs = 0;
  let milk = 0;
  let herd_profit = 0;

  // eggs + milk can exist in same log message
  const eggsRegex = /Added\s+Eggs[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;
  const milkRegex = /Added\s+Milk[\s\S]*?ranch\s+id\s+\d+\s*:\s*(\d+)/gi;

  let m;
  while ((m = eggsRegex.exec(text)) !== null) eggs += Number(m[1] || 0);
  while ((m = milkRegex.exec(text)) !== null) milk += Number(m[1] || 0);

  // Cattle Sale line:
  // "sold 5 Bison for 1200.0$" profit = sell - deduction (bison uses bison deduction, others default)
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

async function renderRanchBoard() {
  const key = "ranch_board_current_msg";
  const channel = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);

  let msgId = await getBoardMessageId(key);
  if (!msgId) {
    const msg = await channel.send({ content: "\u200B" });
    await setBoardMessage(key, RANCH_OUTPUT_CHANNEL_ID, msg.id);
    msgId = msg.id;
  }

  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, eggs, milk, herd_profit
    FROM public.ranch_totals
    WHERE eggs>0 OR milk>0 OR herd_profit<>0
  `);

  const players = rows.map(r => {
    const eggs = Number(r.eggs);
    const milk = Number(r.milk);
    const herdProfit = Number(r.herd_profit);
    const payout = (eggs * EGGS_PRICE) + (milk * MILK_PRICE) + herdProfit;
    return { user_id: r.user_id.toString(), eggs, milk, herdProfit, payout };
  }).sort((a,b)=>b.payout-a.payout);

  let out = `🏆 **Beaver Farms — Weekly Ledger (Compact)**\n`;
  out += `🥚$${EGGS_PRICE} • 🥛$${MILK_PRICE} • Cattle profit: bison(-${CATTLE_BISON_DEDUCTION}) others(-${CATTLE_DEFAULT_DEDUCTION})\n\n`;

  const medals = ["🥇","🥈","🥉"];
  const max = 60;
  for (let i=0;i<Math.min(players.length,max);i++){
    const p = players[i];
    const rank = medals[i] || `#${i+1}`;
    out += `${rank} <@${p.user_id}> | 🥚${p.eggs} 🥛${p.milk} 🐄${money(p.herdProfit)} | 💰 **${money(p.payout)}**\n`;
  }

  const payroll = players.reduce((a,p)=>a+p.payout,0);
  out += `\n---\n💼 **Total Ranch Payroll:** ${money(payroll)}`;

  await msg.edit({ content: out, embeds: [] });
}

// ===================== CAMP PARSE =====================
// Reads same log style you pasted:
// Delivered Supplies: X
// Donated ... Materials added: 1.0
// Made a Sale Of ... For $950 (delivery)
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

  if (materials===0 && supplies===0 && del_small===0 && del_med===0 && del_large===0) return null;
  return { userId, materials, supplies, del_small, del_med, del_large };
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

function campMath(row) {
  const materials = Number(row.materials);
  const supplies = Number(row.supplies);
  const ds = Number(row.del_small);
  const dm = Number(row.del_med);
  const dl = Number(row.del_large);

  const deliveryValue = ds*CAMP_DELIVERY_SMALL + dm*CAMP_DELIVERY_MED + dl*CAMP_DELIVERY_LARGE;
  const deliveries = ds+dm+dl;
  const points = (materials*CAMP_POINTS_MATERIAL) + (supplies*CAMP_POINTS_SUPPLY) + (deliveries*CAMP_POINTS_DELIVERY);

  return { materials, supplies, ds, dm, dl, deliveries, deliveryValue, points };
}

async function renderCampBoard() {
  const key = "camp_board_current_msg";
  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);

  let msgId = await getBoardMessageId(key);
  if (!msgId) {
    const msg = await channel.send({ content: "\u200B" });
    await setBoardMessage(key, CAMP_OUTPUT_CHANNEL_ID, msg.id);
    msgId = msg.id;
  }

  const msg = await channel.messages.fetch(msgId);

  const { rows } = await pool.query(`
    SELECT user_id, materials, supplies, del_small, del_med, del_large
    FROM public.camp_totals
    WHERE materials>0 OR supplies>0 OR del_small>0 OR del_med>0 OR del_large>0
  `);

  const players = rows.map(r => ({ user_id: r.user_id.toString(), ...campMath(r) }));

  const totalDeliveryValue = players.reduce((a,p)=>a+p.deliveryValue,0);
  const totalPoints = players.reduce((a,p)=>a+p.points,0);

  const playerPool = totalDeliveryValue * (1 - CAMP_FEE_RATE);
  const campRevenue = totalDeliveryValue * CAMP_FEE_RATE;
  const valuePerPoint = totalPoints > 0 ? (playerPool / totalPoints) : 0;

  const ranked = players.map(p => ({ ...p, payout: p.points*valuePerPoint }))
    .sort((a,b)=>b.payout-a.payout);

  let out = `🏕️ **Baba Yaga Camp — Weekly Payout (Points)**\n`;
  out += `Fee: ${(CAMP_FEE_RATE*100).toFixed(0)}% • Value/pt: ${money(valuePerPoint)}\n\n`;

  const medals = ["🥇","🥈","🥉"];
  const max = 30;
  for (let i=0;i<Math.min(ranked.length,max);i++){
    const p = ranked[i];
    const rank = medals[i] || `#${i+1}`;
    out += `${rank} <@${p.user_id}>\n`;
    out += `🪨 ${p.materials} | 🚚 ${p.deliveries} (S:${p.ds} M:${p.dm} L:${p.dl}) | 📦 ${p.supplies}\n`;
    out += `⭐ ${p.points} pts | 💰 **${money(p.payout)}**\n\n`;
  }

  out += `---\n🧾 Total Delivery Value: ${money(totalDeliveryValue)} • 💰 Camp Revenue: ${money(campRevenue)} • ⭐ Total Points: ${totalPoints}`;
  await msg.edit({ content: out, embeds: [] });
}

// ===================== POLLERS =====================
let ranchDebounce = null;
let campDebounce = null;

function scheduleRanchUpdate() {
  if (ranchDebounce) return;
  ranchDebounce = setTimeout(async () => {
    ranchDebounce = null;
    await rebuildRanchTotals();
    await renderRanchBoard();
  }, LEADERBOARD_DEBOUNCE_MS);
}

function scheduleCampUpdate() {
  if (campDebounce) return;
  campDebounce = setTimeout(async () => {
    campDebounce = null;
    await rebuildCampTotals();
    await renderCampBoard();
  }, LEADERBOARD_DEBOUNCE_MS);
}

async function pollRanch(limit = 100) {
  const channel = await client.channels.fetch(RANCH_INPUT_CHANNEL_ID);
  const batch = await channel.messages.fetch({ limit });

  let inserted = 0;
  for (const msg of batch.values()) {
    const d = parseRanch(msg);
    if (!d) continue;
    const ok = await insertRanchEvent(msg.id, d);
    if (ok) inserted++;
  }

  if (DEBUG) console.log(`RANCH poll: fetched=${batch.size} inserted=${inserted}`);
  if (inserted > 0) scheduleRanchUpdate();
}

async function pollCamp(limit = 100) {
  const channel = await client.channels.fetch(CAMP_INPUT_CHANNEL_ID);
  const batch = await channel.messages.fetch({ limit });

  let inserted = 0;
  for (const msg of batch.values()) {
    const d = parseCamp(msg);
    if (!d) continue;
    const ok = await insertCampEvent(msg.id, d);
    if (ok) inserted++;
  }

  if (DEBUG) console.log(`CAMP poll: fetched=${batch.size} inserted=${inserted}`);
  if (inserted > 0) scheduleCampUpdate();
}

// Backfill older history once on start (walk back)
async function backfillChannel(channelId, parseFn, insertFn, maxMessages) {
  const channel = await client.channels.fetch(channelId);
  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batchSize = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit: batchSize, before: lastId } : { limit: batchSize });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;
      const d = parseFn(msg);
      if (!d) continue;
      const ok = await insertFn(msg.id, d);
      if (ok) inserted++;
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Backfill channel ${channelId}: scanned=${scanned} inserted=${inserted}`);
}

// ===================== WEEKLY ARCHIVE ROLLOVER =====================
function nowInTZParts(tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
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
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(short);
}

async function weeklyRolloverCheck() {
  const p = nowInTZParts(WEEKLY_ROLLOVER_TZ);
  const dow = dowFromShort(p.weekday);
  const hh = Number(p.hour);
  const mm = Number(p.minute);

  if (dow !== WEEKLY_ROLLOVER_DOW) return;
  if (hh !== WEEKLY_ROLLOVER_HOUR || mm !== WEEKLY_ROLLOVER_MINUTE) return;

  const stamp = `${p.year}-${p.month}-${p.day}`;
  const last = await getState("weekly_rollover_stamp", "");
  if (last === stamp) return;

  console.log(`🗓️ Weekly rollover triggered: ${stamp} ${WEEKLY_ROLLOVER_TZ}`);

  // Create NEW ranch post and reset weekly ranch tables
  {
    const out = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
    const newMsg = await out.send({ content: "\u200B" });
    await setBoardMessage("ranch_board_current_msg", RANCH_OUTPUT_CHANNEL_ID, newMsg.id);

    await pool.query(`TRUNCATE public.ranch_events`);
    await pool.query(`TRUNCATE public.ranch_totals`);
    await renderRanchBoard();
  }

  // Create NEW camp post and reset weekly camp tables
  {
    const out = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
    const newMsg = await out.send({ content: "\u200B" });
    await setBoardMessage("camp_board_current_msg", CAMP_OUTPUT_CHANNEL_ID, newMsg.id);

    await pool.query(`TRUNCATE public.camp_events`);
    await pool.query(`TRUNCATE public.camp_totals`);
    await renderCampBoard();
  }

  await setState("weekly_rollover_stamp", stamp);
  console.log("✅ Weekly rollover complete (new posts created, old posts archived)");
}

// ===================== STARTUP =====================
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);
    await ensureSchema();

    // Optional backfill on start
    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillChannel(RANCH_INPUT_CHANNEL_ID, parseRanch, insertRanchEvent, BACKFILL_MAX_MESSAGES);
      await backfillChannel(CAMP_INPUT_CHANNEL_ID, parseCamp, insertCampEvent, BACKFILL_MAX_MESSAGES);
    }

    // Render boards on boot
    await rebuildRanchTotals();
    await renderRanchBoard();

    await rebuildCampTotals();
    await renderCampBoard();

    // Poll loops
    setInterval(() => pollRanch(100).catch(e => console.error("❌ pollRanch:", e)), BACKFILL_EVERY_MS);
    setInterval(() => pollCamp(100).catch(e => console.error("❌ pollCamp:", e)), BACKFILL_EVERY_MS);

    // Rollover check every 30s
    setInterval(() => weeklyRolloverCheck().catch(e => console.error("❌ weeklyRolloverCheck:", e)), 30 * 1000);

    console.log(`✅ Running. Poll=${BACKFILL_EVERY_MS}ms, Rollover=Sat ${WEEKLY_ROLLOVER_HOUR}:${String(WEEKLY_ROLLOVER_MINUTE).padStart(2,"0")} ${WEEKLY_ROLLOVER_TZ}`);
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

// ===================== SHUTDOWN =====================
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
