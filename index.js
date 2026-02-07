// index.js — Beaver Falls Ranch + Camp Manager
// Ranch leaderboard now uses the “3-column embed pages” layout (carbon copy style)

import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

dotenv.config();
const { Pool } = pg;

/* ================= ENV ================= */
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const PAYOUT_ARCHIVE_CHANNEL_ID = process.env.PAYOUT_ARCHIVE_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error("❌ Missing Railway variable: DISCORD_TOKEN");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ Missing Railway variable: DATABASE_URL");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("❌ Missing Railway variable: GUILD_ID");
  process.exit(1);
}
if (!PAYOUT_ARCHIVE_CHANNEL_ID) {
  console.error("❌ Missing Railway variable: PAYOUT_ARCHIVE_CHANNEL_ID");
  process.exit(1);
}

const DEBUG = String(process.env.debug || "false").toLowerCase() === "true";

// Channels
const RANCH_INPUT_CHANNEL_ID =
  process.env.RANCH_INPUT_CHANNEL_ID ||
  process.env.INPUT_CHANNEL_ID ||
  process.env.CHANNEL_ID;

const RANCH_OUTPUT_CHANNEL_ID =
  process.env.RANCH_OUTPUT_CHANNEL_ID || process.env.LEADERBOARD_CHANNEL_ID;

const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

if (!RANCH_INPUT_CHANNEL_ID || !RANCH_OUTPUT_CHANNEL_ID) {
  console.error(
    "❌ Missing Railway variables: RANCH_INPUT_CHANNEL_ID / RANCH_OUTPUT_CHANNEL_ID"
  );
  process.exit(1);
}
if (!CAMP_INPUT_CHANNEL_ID || !CAMP_OUTPUT_CHANNEL_ID) {
  console.error(
    "❌ Missing Railway variables: CAMP_INPUT_CHANNEL_ID / CAMP_OUTPUT_CHANNEL_ID"
  );
  process.exit(1);
}

const BACKFILL_ON_START =
  String(process.env.BACKFILL_ON_START || "true").toLowerCase() === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 1000);

// refresh every 2000ms
const POLL_EVERY_MS = 2000;

const WEEKLY_TZ = process.env.WEEKLY_ROLLOVER_TZ || "America/New_York";
const WEEKLY_DOW = Number(process.env.WEEKLY_ROLLOVER_DOW ?? 6); // Saturday
const WEEKLY_HOUR = Number(process.env.WEEKLY_ROLLOVER_HOUR ?? 12); // noon
const WEEKLY_MINUTE = Number(process.env.WEEKLY_ROLLOVER_MINUTE ?? 0);

// Ranch math
const EGGS_PRICE = 1.25;
const MILK_PRICE = 1.25;
const CATTLE_BISON_DEDUCTION = Number(process.env.CATTLE_BISON_DEDUCTION || 400);
const CATTLE_DEFAULT_DEDUCTION = Number(
  process.env.CATTLE_DEFAULT_DEDUCTION || 300
);

// Camp math
const CAMP_FEE_RATE = 0.30;
const PTS_MATERIAL = 2;
const PTS_DELIVERY = 3;
const PTS_SUPPLY = 1;

// Delivery tiering by RANGE
const CAMP_LARGE_MIN = Number(process.env.CAMP_LARGE_MIN || 1400);
const CAMP_MED_MIN = Number(process.env.CAMP_MED_MIN || 800);

const CAMP_DELIVERY_SMALL_VALUE = Number(process.env.CAMP_DELIVERY_SMALL || 500);
const CAMP_DELIVERY_MED_VALUE = Number(process.env.CAMP_DELIVERY_MED || 950);
const CAMP_DELIVERY_LARGE_VALUE = Number(process.env.CAMP_DELIVERY_LARGE || 1500);

/* ================= DB + APP ================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("Beaver Falls Manager ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/admin/resync", async (req, res) => {
  try {
    if (!ADMIN_KEY)
      return res.status(500).json({ ok: false, error: "ADMIN_KEY not set" });
    if (req.query.key !== ADMIN_KEY)
      return res.status(403).json({ ok: false, error: "Forbidden" });

    const scope = String(req.query.scope || "all").toLowerCase();

    const ranchWeekStartIso = await getState(
      "ranch_week_start_iso",
      new Date().toISOString()
    );
    const campWeekStartIso = await getState(
      "camp_week_start_iso",
      new Date().toISOString()
    );

    const ranchMinTs = new Date(ranchWeekStartIso).getTime();
    const campMinTs = new Date(campWeekStartIso).getTime();

    const out = { ranch: null, camp: null };

    if (scope === "all" || scope === "ranch") {
      await pool.query(`TRUNCATE public.ranch_events`);
      await pool.query(`TRUNCATE public.ranch_totals`);

      const inserted = await backfillChannel(
        RANCH_INPUT_CHANNEL_ID,
        parseRanch,
        insertRanchEvent,
        "RANCH",
        ranchMinTs
      );
      await rebuildRanchTotals();
      await renderRanchBoard(false);

      out.ranch = { inserted, week_start: ranchWeekStartIso };
    }

    if (scope === "all" || scope === "camp") {
      await pool.query(`TRUNCATE public.camp_events`);
      await pool.query(`TRUNCATE public.camp_totals`);

      const inserted = await backfillChannel(
        CAMP_INPUT_CHANNEL_ID,
        parseCamp,
        insertCampEvent,
        "CAMP",
        campMinTs
      );
      await rebuildCampTotals();
      await renderCampBoard(false);

      out.camp = { inserted, week_start: campWeekStartIso };
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error("❌ /admin/resync error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Web listening on ${PORT}`)
);

/* ================= DISCORD ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) =>
  console.error("❌ unhandledRejection:", r)
);
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

/* ================= NAME RESOLUTION ================= */
let guildCache = null;
const nameCache = new Map();

async function getGuild() {
  if (guildCache) return guildCache;
  guildCache = await client.guilds.fetch(GUILD_ID);
  return guildCache;
}

async function displayNameFor(userId) {
  const cached = nameCache.get(userId);
  if (cached) return cached;

  try {
    const guild = await getGuild();
    const member = await guild.members.fetch(userId);
    const name =
      member?.displayName ||
      member?.user?.globalName ||
      member?.user?.username ||
      `user-${String(userId).slice(-4)}`;
    nameCache.set(userId, name);
    return name;
  } catch {
    return `user-${String(userId).slice(-4)}`;
  }
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

/* ================= SCHEMA / STATE ================= */
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
      cattle_sold INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.ranch_totals (
      user_id BIGINT PRIMARY KEY,
      eggs INT NOT NULL DEFAULT 0,
      milk INT NOT NULL DEFAULT 0,
      herd_profit NUMERIC NOT NULL DEFAULT 0,
      cattle_sold INT NOT NULL DEFAULT 0,
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
}

async function getState(key, fallback = null) {
  const { rows } = await pool.query(
    `SELECT value FROM public.bot_state WHERE key=$1 LIMIT 1`,
    [key]
  );
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
  const { rows } = await pool.query(
    `SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`,
    [key]
  );
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

async function initWeekStartsIfMissing() {
  const r = await getState("ranch_week_start_iso", null);
  if (!r) await setState("ranch_week_start_iso", new Date().toISOString());
  const c = await getState("camp_week_start_iso", null);
  if (!c) await setState("camp_week_start_iso", new Date().toISOString());
}

/* ================= TIME HELPERS ================= */
function fmtShortTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: WEEKLY_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function fmtDateRange(start, end) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: WEEKLY_TZ,
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
  return `${fmt.format(start)}–${fmt.format(end)}`;
}

function getNextSaturdayNoonET(fromDate = new Date()) {
  // Build "next Saturday at 12:00" in ET using Intl parts and a safe loop.
  // Simple + reliable: walk forward day-by-day until Saturday, then set noon.
  const d = new Date(fromDate);
  for (let i = 0; i < 8; i++) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: WEEKLY_TZ,
      weekday: "short",
    }).format(d);
    if (weekday === "Sat") break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Now set to noon ET by constructing a string in ET and parsing is messy;
  // we’ll just show "Saturday" like the example (date optional).
  return "Saturday";
}

/* ================= DISCORD MESSAGE HELPERS ================= */
async function ensureCurrentMessage(key, channelId, defaultText) {
  const channel = await client.channels.fetch(channelId);
  let msgId = await getBoardMessageId(key);

  if (!msgId) {
    const msg = await channel.send({ content: defaultText });
    await setBoardMessage(key, channelId, msg.id);
    return msg.id;
  }

  try {
    await channel.messages.fetch(msgId);
    return msgId;
  } catch {
    const msg = await channel.send({ content: defaultText });
    await setBoardMessage(key, channelId, msg.id);
    return msg.id;
  }
}

/* ================= MESSAGE TEXT EXTRACT ================= */
function embedToText(embed) {
  try {
    const data =
      embed?.data ||
      (typeof embed?.toJSON === "function" ? embed.toJSON() : embed) ||
      {};
    let out = "";
    if (data.title) out += `\n${data.title}`;
    if (data.description) out += `\n${data.description}`;
    if (data.author?.name) out += `\n${data.author.name}`;
    if (Array.isArray(data.fields)) {
      for (const f of data.fields) out += `\n${f.name}\n${f.value}`;
    }
    if (data.footer?.text) out += `\n${data.footer.text}`;
    return out.trim();
  } catch {
    return "";
  }
}

function extractAllText(message) {
  let text = (message.content || "").trim();
  if (Array.isArray(message.embeds) && message.embeds.length) {
    for (const e of message.embeds) {
      const t = embedToText(e);
      if (t) text += `\n${t}`;
    }
  }
  return text.trim();
}

function getUserIdFromMessage(message, text) {
  const first = message.mentions?.users?.first?.();
  if (first?.id) return first.id;

  const discordLine = text.match(/Discord:\s*.*?(\d{17,19})\b/i);
  if (discordLine) return discordLine[1];

  const mention = text.match(/<@!?(\d{17,19})>/);
  if (mention) return mention[1];

  const atLine = text.match(/@\S+\s+(\d{17,19})\b/);
  if (atLine) return atLine[1];

  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function lastColonNumber(text) {
  const matches = [...text.matchAll(/:\s*(\d+)\b/g)];
  if (!matches.length) return 0;
  return Number(matches[matches.length - 1][1] || 0);
}

/* ================= PARSERS ================= */
function parseRanch(message) {
  const text = extractAllText(message);
  if (!text) return null;

  if (
    !/Eggs\s+Added|Milk\s+Added|Added\s+Eggs|Added\s+Milk|Cattle\s+Sale|sold\s+\d+/i.test(
      text
    )
  ) {
    return null;
  }

  const userId = getUserIdFromMessage(message, text);
  if (!userId) return null;

  let eggs = 0;
  let milk = 0;
  let herd_profit = 0;
  let cattle_sold = 0;

  if (/Eggs\s+Added|Added\s+Eggs/i.test(text)) eggs += lastColonNumber(text);
  if (/Milk\s+Added|Added\s+Milk/i.test(text)) milk += lastColonNumber(text);

  const saleA = text.match(
    /sold\s+(\d+)\s+(.+?)\s+for\s+([0-9]+(?:\.[0-9]+)?)\$/i
  );

  const saleBQty = text.match(/sold\s+(\d+)\b/i);
  const saleBAmount = text.match(/for\s+([0-9]+(?:\.[0-9]+)?)\$/i);

  if (saleA) {
    const qty = Number(saleA[1] || 0);
    const animal = String(saleA[2] || "").trim().toLowerCase();
    const sell = Number(saleA[3] || 0);

    cattle_sold += qty;

    const deduction = animal.includes("bison")
      ? CATTLE_BISON_DEDUCTION
      : CATTLE_DEFAULT_DEDUCTION;

    herd_profit += sell - deduction;
  } else if (saleBQty && saleBAmount) {
    const qty = Number(saleBQty[1] || 0);
    const sell = Number(saleBAmount[1] || 0);

    cattle_sold += qty;
    herd_profit += sell - CATTLE_DEFAULT_DEDUCTION;
  }

  if (eggs === 0 && milk === 0 && herd_profit === 0 && cattle_sold === 0)
    return null;

  return { userId, eggs, milk, herd_profit, cattle_sold };
}

function parseCamp(message) {
  const text = extractAllText(message);
  if (!text) return null;

  if (
    !/Delivered\s+Supplies|Materials\s+added|Made\s+a\s+Sale\s+Of/i.test(text)
  ) {
    return null;
  }

  const userId = getUserIdFromMessage(message, text);
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

  const sale = text.match(
    /Made\s+a\s+Sale\s+Of\s+\d+\s+Of\s+Stock\s+For\s+\$?([0-9]+(?:\.[0-9]+)?)/i
  );
  if (sale) {
    const amt = Math.round(Number(sale[1] || 0));
    if (amt >= CAMP_LARGE_MIN) del_large++;
    else if (amt >= CAMP_MED_MIN) del_med++;
    else del_small++;
  }

  if (
    materials === 0 &&
    supplies === 0 &&
    del_small === 0 &&
    del_med === 0 &&
    del_large === 0
  )
    return null;

  return { userId, materials, supplies, del_small, del_med, del_large };
}

/* ================= INSERTS + TOTALS ================= */
async function insertRanchEvent(msgId, d) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.ranch_events
      (discord_message_id, user_id, eggs, milk, herd_profit, cattle_sold)
    VALUES
      ($1, $2::bigint, $3::int, $4::int, $5::numeric, $6::int)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [msgId, d.userId, d.eggs, d.milk, d.herd_profit, d.cattle_sold]
  );
  return rowCount > 0;
}

async function insertCampEvent(msgId, d) {
  const { rowCount } = await pool.query(
    `
    INSERT INTO public.camp_events
      (discord_message_id, user_id, materials, supplies, del_small, del_med, del_large)
    VALUES
      ($1, $2::bigint, $3::int, $4::int, $5::int, $6::int, $7::int)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [msgId, d.userId, d.materials, d.supplies, d.del_small, d.del_med, d.del_large]
  );
  return rowCount > 0;
}

async function rebuildRanchTotals() {
  await pool.query(`TRUNCATE public.ranch_totals`);
  await pool.query(`
    INSERT INTO public.ranch_totals (user_id, eggs, milk, herd_profit, cattle_sold, updated_at)
    SELECT user_id,
      COALESCE(SUM(eggs),0)::int,
      COALESCE(SUM(milk),0)::int,
      COALESCE(SUM(herd_profit),0)::numeric,
      COALESCE(SUM(cattle_sold),0)::int,
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

/* ================= RANCH EMBED “CARBON COPY” ================= */
async function buildRanchEmbeds(isFinal) {
  const { rows } = await pool.query(`
    SELECT user_id, eggs, milk, herd_profit, cattle_sold
    FROM public.ranch_totals
    WHERE eggs>0 OR milk>0 OR herd_profit<>0 OR cattle_sold>0
  `);

  const players = rows
    .map((r) => {
      const eggs = Number(r.eggs);
      const milk = Number(r.milk);
      const profit = Number(r.herd_profit);
      const cattle = Number(r.cattle_sold);
      const total = eggs * EGGS_PRICE + milk * MILK_PRICE + profit;
      return { user_id: r.user_id.toString(), eggs, milk, profit, cattle, total };
    })
    .sort((a, b) => b.total - a.total);

  const totalPayout = players.reduce((a, p) => a + p.total, 0);
  const totalMilk = players.reduce((a, p) => a + p.milk, 0);
  const totalEggs = players.reduce((a, p) => a + p.eggs, 0);
  const totalProfit = players.reduce((a, p) => a + p.profit, 0);

  // Page like the screenshot: 3 columns, 4 rows => 12 players per page
  const PER_PAGE = 12;
  const pageCount = Math.max(1, Math.ceil(players.length / PER_PAGE));

  const nextPayoutLabel = getNextSaturdayNoonET(new Date());

  const now = new Date();
  const weekStartIso = await getState("ranch_week_start_iso", now.toISOString());
  const weekStart = new Date(weekStartIso);

  const embeds = [];

  for (let page = 0; page < pageCount; page++) {
    const slice = players.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle(`🏆 Beaver Falls Ranch — Page ${page + 1}/${pageCount}`)
      .setDescription(
        `📅 Next Ranch Payout: ${nextPayoutLabel}${isFinal ? `\n✅ FINAL` : ""}`
      );

    // Top row (inline fields like screenshot)
    embed.addFields(
      {
        name: "💰 Ranch Payout",
        value: `**${money(totalPayout)}**`,
        inline: true,
      },
      {
        name: "🥛",
        value: `**${totalMilk.toLocaleString()}**`,
        inline: true,
      },
      {
        name: "🥚",
        value: `**${totalEggs.toLocaleString()}**`,
        inline: true,
      }
    );

    // Player columns
    for (const p of slice) {
      const name = await displayNameFor(p.user_id);

      const milkPay = p.milk * MILK_PRICE;
      const eggsPay = p.eggs * EGGS_PRICE;

      // Keep it EXACT style: show item → payout
      // You asked: bottom shows total ranch profit; and player totals.
      // We show cattle profit line if they have it, but no “deductions/profits taken out” text.
      const cattleLine =
        p.profit !== 0 ? `🐄 Cattle: ${money(p.profit)}` : `🐄 Cattle: $0.00`;

      embed.addFields({
        name: name,
        value:
          `🥛 Milk: ${p.milk.toLocaleString()} -> ${money(milkPay)}\n` +
          `🥚 Eggs: ${p.eggs.toLocaleString()} -> ${money(eggsPay)}\n` +
          `${cattleLine}\n` +
          `💰 **Total: ${money(p.total)}**`,
        inline: true,
      });
    }

    // Footer like screenshot: total profit + “Today at …”
    embed.setFooter({
      text: `Total Ranch Profit: ${money(totalProfit)} • Today at ${fmtShortTime(
        now
      )}`,
    });

    // Optional: timestamp (Discord will show hover time)
    embed.setTimestamp(now);

    // Extra: keep date range visible only on Page 1 like the example does NOT show range;
    // If you want it, uncomment:
    // if (page === 0) embed.setAuthor({ name: `Week: ${fmtDateRange(weekStart, now)}` });

    embeds.push(embed);
  }

  return embeds;
}

/* ================= RANCH RENDER (STATIC MESSAGE EDIT) ================= */
async function renderRanchBoard(isFinal = false) {
  const key = "ranch_current_msg";
  const msgId = await ensureCurrentMessage(
    key,
    RANCH_OUTPUT_CHANNEL_ID,
    "🏆 **Beaver Falls Ranch**\n(loading...)"
  );

  const channel = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  const embeds = await buildRanchEmbeds(isFinal);

  // Discord allows up to 10 embeds per message.
  // If you ever exceed 10 pages, we’ll need to switch to multi-message paging.
  await msg.edit({ content: "", embeds });

  return embeds;
}

/* ================= CAMP RENDER (UNCHANGED TEXT STYLE) ================= */
function campMathRow(r) {
  const materials = Number(r.materials);
  const supplies = Number(r.supplies);
  const ds = Number(r.del_small);
  const dm = Number(r.del_med);
  const dl = Number(r.del_large);
  const deliveries = ds + dm + dl;

  const deliveryValue =
    ds * CAMP_DELIVERY_SMALL_VALUE +
    dm * CAMP_DELIVERY_MED_VALUE +
    dl * CAMP_DELIVERY_LARGE_VALUE;

  const points =
    materials * PTS_MATERIAL + supplies * PTS_SUPPLY + deliveries * PTS_DELIVERY;

  return { materials, supplies, ds, dm, dl, deliveries, deliveryValue, points };
}

async function renderCampBoard(isFinal = false) {
  const key = "camp_current_msg";
  const msgId = await ensureCurrentMessage(
    key,
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

  const players = rows.map((r) => ({
    user_id: r.user_id.toString(),
    ...campMathRow(r),
  }));

  const totalDeliveryValue = players.reduce((a, p) => a + p.deliveryValue, 0);
  const totalPoints = players.reduce((a, p) => a + p.points, 0);

  const playerPool = totalDeliveryValue * (1 - CAMP_FEE_RATE);
  const campRevenue = totalDeliveryValue * CAMP_FEE_RATE;
  const valuePerPoint = totalPoints > 0 ? playerPool / totalPoints : 0;

  const ranked = players
    .map((p) => ({ ...p, payout: p.points * valuePerPoint }))
    .sort((a, b) => b.payout - a.payout);

  const now = new Date();
  const weekStartIso = await getState("camp_week_start_iso", now.toISOString());
  const weekStart = new Date(weekStartIso);

  let out = `🏕️ **Beaver Falls Camp — Weekly Payout (Points)${
    isFinal ? " (FINAL)" : ""
  }**\n`;
  out += `📅 ${fmtDateRange(weekStart, now)}\n`;
  out += `Fee: ${(CAMP_FEE_RATE * 100).toFixed(0)}% • Value/pt: ${money(
    valuePerPoint
  )}\n\n`;

  const medals = ["🥇", "🥈", "🥉"];
  const max = 80;

  for (let i = 0; i < Math.min(ranked.length, max); i++) {
    const p = ranked[i];
    const rank = medals[i] || `#${i + 1}`;
    const name = await displayNameFor(p.user_id);

    out += `${rank} @${name} | 🪨${p.materials} 🚚${p.deliveries}(S${p.ds}/M${p.dm}/L${p.dl}) 📦${p.supplies} | ⭐${p.points} | 💰 **${money(
      p.payout
    )}**\n`;
  }

  out += `\n---\n🧾 Total Delivery: ${money(
    totalDeliveryValue
  )} • 💰 Camp Revenue: ${money(campRevenue)} • ⭐ Total Points: ${totalPoints}`;

  await msg.edit({ content: out, embeds: [] });
  return out;
}

/* ================= ARCHIVE + WEEKLY ROLLOVER (kept as-is) ================= */
async function sendLong(channel, text) {
  const max = 1900;
  if (text.length <= max) {
    await channel.send({ content: text });
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > max) {
      await channel.send({ content: chunk });
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) await channel.send({ content: chunk });
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

async function rolloverIfDue() {
  const p = nowInTZParts();
  const dow = dowFromShort(p.weekday);
  const hh = Number(p.hour);
  const mm = Number(p.minute);

  if (dow !== WEEKLY_DOW) return;
  if (hh !== WEEKLY_HOUR || mm !== WEEKLY_MINUTE) return;

  const stamp = `${p.year}-${p.month}-${p.day}`;
  const last = await getState("weekly_rollover_stamp", "");
  if (last === stamp) return;

  console.log(`🗓️ Weekly rollover triggered (${stamp} ${WEEKLY_TZ})`);

  await rebuildRanchTotals();
  await rebuildCampTotals();

  // Finalize boards
  await renderRanchBoard(true);
  await renderCampBoard(true);

  const archiveChannel = await client.channels.fetch(PAYOUT_ARCHIVE_CHANNEL_ID);
  await sendLong(
    archiveChannel,
    `📦 **Beaver Falls — Weekly Payout Archive**\n(Archived Saturday @ 12:00 PM ET)\n`
  );

  // For ranch, we archive by posting “simple text snapshot” since embeds are already on the main board.
  // If you want the archive to also use embeds, say so and I’ll do embed copies.
  const now = new Date();
  const ranchStart = new Date(await getState("ranch_week_start_iso", now.toISOString()));
  const campStart = new Date(await getState("camp_week_start_iso", now.toISOString()));

  await sendLong(
    archiveChannel,
    `🏆 Ranch Week: ${fmtDateRange(ranchStart, now)}\n(See ranch channel for embedded pages)`
  );
  await sendLong(
    archiveChannel,
    `🏕️ Camp Week: ${fmtDateRange(campStart, now)}\n(See camp channel for details)`
  );

  // Fresh new current-week messages
  {
    const ch = await client.channels.fetch(RANCH_OUTPUT_CHANNEL_ID);
    const m = await ch.send({ content: "🏆 **Beaver Falls Ranch**\n(Starting new week…)" });
    await setBoardMessage("ranch_current_msg", RANCH_OUTPUT_CHANNEL_ID, m.id);
  }
  {
    const ch = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
    const m = await ch.send({
      content: "🏕️ **Beaver Falls Camp — Weekly Payout (Points)**\n(Starting new week…)",
    });
    await setBoardMessage("camp_current_msg", CAMP_OUTPUT_CHANNEL_ID, m.id);
  }

  await pool.query(`TRUNCATE public.ranch_events`);
  await pool.query(`TRUNCATE public.ranch_totals`);
  await pool.query(`TRUNCATE public.camp_events`);
  await pool.query(`TRUNCATE public.camp_totals`);

  const nowIso = new Date().toISOString();
  await setState("ranch_week_start_iso", nowIso);
  await setState("camp_week_start_iso", nowIso);

  await renderRanchBoard(false);
  await renderCampBoard(false);

  await setState("weekly_rollover_stamp", stamp);
  console.log("✅ Weekly rollover complete");
}

/* ================= BACKFILL / POLL ================= */
async function backfillChannel(
  channelId,
  parseFn,
  insertFn,
  label,
  minTimestampMs = 0
) {
  const channel = await client.channels.fetch(channelId);

  let lastId = null;
  let scanned = 0;
  let inserted = 0;

  while (scanned < BACKFILL_MAX_MESSAGES) {
    const limit = Math.min(100, BACKFILL_MAX_MESSAGES - scanned);
    const batch = await channel.messages.fetch(
      lastId ? { limit, before: lastId } : { limit }
    );
    if (!batch.size) break;

    const msgs = [...batch.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const msg of msgs) {
      scanned++;

      if (minTimestampMs && msg.createdTimestamp < minTimestampMs) continue;

      const d = parseFn(msg);
      if (!d) continue;

      const ok = await insertFn(msg.id, d);
      if (ok) inserted++;
    }

    if (minTimestampMs && msgs[0]?.createdTimestamp < minTimestampMs) break;

    lastId = msgs[0].id;
  }

  console.log(`📥 ${label} backfill scanned=${scanned} inserted=${inserted}`);
  return inserted;
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

/* ================= STARTUP ================= */
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);

    await ensureSchema();
    await initWeekStartsIfMissing();
    await getGuild();

    await renderRanchBoard(false);
    await renderCampBoard(false);

    if (BACKFILL_ON_START) {
      const ranchWeekStartIso = await getState(
        "ranch_week_start_iso",
        new Date().toISOString()
      );
      const campWeekStartIso = await getState(
        "camp_week_start_iso",
        new Date().toISOString()
      );
      const ranchMinTs = new Date(ranchWeekStartIso).getTime();
      const campMinTs = new Date(campWeekStartIso).getTime();

      console.log(`📥 Backfilling ranch + camp (max ${BACKFILL_MAX_MESSAGES})...`);
      const rInserted = await backfillChannel(
        RANCH_INPUT_CHANNEL_ID,
        parseRanch,
        insertRanchEvent,
        "RANCH",
        ranchMinTs
      );
      const cInserted = await backfillChannel(
        CAMP_INPUT_CHANNEL_ID,
        parseCamp,
        insertCampEvent,
        "CAMP",
        campMinTs
      );

      if (rInserted > 0) {
        await rebuildRanchTotals();
        await renderRanchBoard(false);
      }
      if (cInserted > 0) {
        await rebuildCampTotals();
        await renderCampBoard(false);
      }
    }

    setInterval(async () => {
      try {
        const r = await pollOnce(
          RANCH_INPUT_CHANNEL_ID,
          parseRanch,
          insertRanchEvent,
          "RANCH"
        );
        if (r > 0) {
          await rebuildRanchTotals();
          await renderRanchBoard(false);
        }
      } catch (e) {
        console.error("❌ Ranch poll error:", e);
      }
    }, POLL_EVERY_MS);

    setInterval(async () => {
      try {
        const c = await pollOnce(
          CAMP_INPUT_CHANNEL_ID,
          parseCamp,
          insertCampEvent,
          "CAMP"
        );
        if (c > 0) {
          await rebuildCampTotals();
          await renderCampBoard(false);
        }
      } catch (e) {
        console.error("❌ Camp poll error:", e);
      }
    }, POLL_EVERY_MS);

    setInterval(() => {
      rolloverIfDue().catch((e) => console.error("❌ rolloverIfDue:", e));
    }, 30_000);

    console.log("✅ Running.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

/* ================= SHUTDOWN ================= */
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
