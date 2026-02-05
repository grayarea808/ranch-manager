import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

dotenv.config();
const { Pool } = pg;

// ================= ENV =================
const PORT = process.env.PORT || 8080;

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Missing Railway variable: BOT_TOKEN or DISCORD_TOKEN");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const CAMP_INPUT_CHANNEL_ID = process.env.CAMP_INPUT_CHANNEL_ID;
const CAMP_OUTPUT_CHANNEL_ID = process.env.CAMP_OUTPUT_CHANNEL_ID;

if (!DATABASE_URL || !CAMP_INPUT_CHANNEL_ID || !CAMP_OUTPUT_CHANNEL_ID) {
  console.error("❌ Missing required Railway variables: DATABASE_URL / CAMP_INPUT_CHANNEL_ID / CAMP_OUTPUT_CHANNEL_ID");
  process.exit(1);
}

const BACKFILL_ON_START = (process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 5000);

const CAMP_NAME = process.env.CAMP_NAME || "Baba Yaga Camp";
const NEXT_PAYOUT_LABEL = process.env.NEXT_PAYOUT_LABEL || "Saturday";

// Delivery tier values
const DELIVERY_VALUES = {
  small: 500,
  medium: 950,
  large: 1500,
};

// Sale values seen in logs -> tier mapping
const SALE_VALUE_TO_TIER = {
  500: "small",
  950: "medium",
  1500: "large",
  1900: "large", // keep if your server uses 1900 as “large-like”
};

const CAMP_CUT = 0.30;
const MATERIAL_POINTS = 2;
const DELIVERY_POINTS = 3;
const SUPPLY_POINTS = 1;

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Camp Tracker running ✅"));
app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Web listening on ${PORT}`));

// ================= DISCORD =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.on("error", (e) => console.error("❌ Discord error:", e));
process.on("unhandledRejection", (r) => console.error("❌ unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));

// ================= SCHEMA =================
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.camp_users (
      user_id BIGINT PRIMARY KEY,
      discord_tag TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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
  `);
}

// ================= STATIC MESSAGE =================
async function ensureBotMessage(key, channelId, initialText) {
  const { rows } = await pool.query(
    `SELECT message_id FROM public.bot_messages WHERE key=$1 LIMIT 1`,
    [key]
  );

  const channel = await client.channels.fetch(channelId);

  if (rows.length) {
    const msgId = rows[0].message_id.toString();
    try {
      await channel.messages.fetch(msgId);
      return msgId;
    } catch {}
  }

  const msg = await channel.send(initialText);

  await pool.query(
    `
    INSERT INTO public.bot_messages (key, channel_id, message_id, updated_at)
    VALUES ($1, $2::bigint, $3::bigint, NOW())
    ON CONFLICT (key)
    DO UPDATE SET channel_id=EXCLUDED.channel_id, message_id=EXCLUDED.message_id, updated_at=NOW()
    `,
    [key, channelId, msg.id]
  );

  return msg.id;
}

// ================= TEXT EXTRACTION =================
function extractAllText(message) {
  let text = (message.content || "").trim();

  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.title) text += `\n${e.title}`;
      if (e.description) text += `\n${e.description}`;
      if (e.author?.name) text += `\n${e.author.name}`;
      if (e.fields?.length) {
        for (const f of e.fields) {
          if (f.name) text += `\n${f.name}`;
          if (f.value) text += `\n${f.value}`;
        }
      }
      if (e.footer?.text) text += `\n${e.footer.text}`;
    }
  }

  return text.trim();
}

// ✅ Pull BOTH @name and id from: "Discord: @Peter 359854613186215936"
function extractDiscordIdentity(text) {
  const m = text.match(/Discord:\s*@([^\s]+)\s+(\d{17,19})/i);
  if (m) {
    return { tag: `@${m[1]}`, userId: m[2] };
  }
  // fallback: just id
  const any = text.match(/\b(\d{17,19})\b/);
  if (any) return { tag: `<@${any[1]}>`, userId: any[1] };
  return null;
}

// ================= PARSER =================
function parseCampLog(message) {
  const text = extractAllText(message);
  if (!text) return null;

  const ident = extractDiscordIdentity(text);
  if (!ident) return null;

  // Delivered Supplies: 42
  const sup = text.match(/Delivered Supplies:\s*(\d+)/i);
  if (sup) {
    const amount = Number(sup[1] || 0);
    if (amount > 0) return { userId: ident.userId, tag: ident.tag, item: "supplies", amount };
  }

  // Materials added: 1.0
  const mat = text.match(/Materials added:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (mat) {
    const amount = Math.floor(Number(mat[1] || 0));
    if (amount > 0) return { userId: ident.userId, tag: ident.tag, item: "materials", amount };
  }

  // Made a Sale Of 50 Of Stock For $950
  const sale = text.match(/Made a Sale Of\s+\d+\s+Of Stock For\s+\$([0-9]+(?:\.[0-9]+)?)/i);
  if (sale) {
    const value = Math.round(Number(sale[1]));
    const tier = SALE_VALUE_TO_TIER[value];
    if (tier) return { userId: ident.userId, tag: ident.tag, item: tier, amount: 1 };
  }

  return null;
}

// ================= DB OPS =================
async function upsertUserTag(userId, tag) {
  // store ONLY clean @name if available; if it’s <@id> fallback, still store it but we’ll try to overwrite later
  await pool.query(
    `
    INSERT INTO public.camp_users (user_id, discord_tag, updated_at)
    VALUES ($1::bigint, $2, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET discord_tag = EXCLUDED.discord_tag, updated_at = NOW()
    `,
    [userId, tag]
  );
}

async function insertEvent(discordMessageId, parsed) {
  // save user tag first (so display is always available)
  if (parsed.tag) await upsertUserTag(parsed.userId, parsed.tag);

  const { rowCount } = await pool.query(
    `
    INSERT INTO public.camp_events (discord_message_id, user_id, item, amount)
    VALUES ($1, $2::bigint, $3, $4::int)
    ON CONFLICT (discord_message_id) DO NOTHING
    `,
    [discordMessageId, parsed.userId, parsed.item, parsed.amount]
  );
  return rowCount > 0;
}

async function rebuildTotals() {
  await pool.query(`TRUNCATE public.camp_totals`);

  await pool.query(`
    INSERT INTO public.camp_totals (user_id, material_sets, supplies, small, medium, large, updated_at)
    SELECT
      user_id,
      COALESCE(SUM(CASE WHEN item='materials' THEN amount ELSE 0 END),0)::int AS material_sets,
      COALESCE(SUM(CASE WHEN item='supplies' THEN amount ELSE 0 END),0)::int AS supplies,
      COALESCE(SUM(CASE WHEN item='small' THEN amount ELSE 0 END),0)::int AS small,
      COALESCE(SUM(CASE WHEN item='medium' THEN amount ELSE 0 END),0)::int AS medium,
      COALESCE(SUM(CASE WHEN item='large' THEN amount ELSE 0 END),0)::int AS large,
      NOW()
    FROM public.camp_events
    GROUP BY user_id
  `);
}

// ================= BACKFILL =================
async function backfillFromHistory(maxMessages) {
  const channel = await client.channels.fetch(CAMP_INPUT_CHANNEL_ID);

  let lastId = null;
  let scanned = 0;
  let parsedCount = 0;
  let inserted = 0;

  while (scanned < maxMessages) {
    const batchSize = Math.min(100, maxMessages - scanned);
    const batch = await channel.messages.fetch(lastId ? { limit: batchSize, before: lastId } : { limit: batchSize });
    if (!batch.size) break;

    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const msg of sorted) {
      scanned++;
      if (!msg.webhookId && !msg.author?.bot) continue;

      const parsed = parseCampLog(msg);
      if (!parsed) continue;
      parsedCount++;

      const ok = await insertEvent(msg.id, parsed);
      if (ok) inserted++;
    }

    lastId = sorted[0].id;
  }

  console.log(`📥 Camp backfill: scanned=${scanned} parsed=${parsedCount} inserted=${inserted}`);
}

// ================= BOARD RENDER =================
function computePoints(p) {
  const deliveries = p.small + p.medium + p.large;
  return (p.material_sets * MATERIAL_POINTS) + (deliveries * DELIVERY_POINTS) + (p.supplies * SUPPLY_POINTS);
}

function totalDeliveryValue(p) {
  return (p.small * DELIVERY_VALUES.small) +
         (p.medium * DELIVERY_VALUES.medium) +
         (p.large * DELIVERY_VALUES.large);
}

function fmtMoney(x) {
  return `$${Number(x).toFixed(2)}`;
}

async function updateCampBoard() {
  const msgId = await ensureBotMessage(
    "camp_board",
    CAMP_OUTPUT_CHANNEL_ID,
    `🏕️ ${CAMP_NAME}\nLoading...`
  );

  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  const msg = await channel.messages.fetch(msgId);

  // pull totals + stored tags
  const { rows } = await pool.query(`
    SELECT
      t.user_id,
      COALESCE(u.discord_tag, ('<@' || t.user_id::text || '>')) AS discord_tag,
      t.material_sets, t.supplies, t.small, t.medium, t.large
    FROM public.camp_totals t
    LEFT JOIN public.camp_users u ON u.user_id = t.user_id
    WHERE t.material_sets>0 OR t.supplies>0 OR t.small>0 OR t.medium>0 OR t.large>0
  `);

  const players = rows.map(r => {
    const p = {
      user_id: r.user_id.toString(),
      tag: String(r.discord_tag),
      material_sets: Number(r.material_sets),
      supplies: Number(r.supplies),
      small: Number(r.small),
      medium: Number(r.medium),
      large: Number(r.large),
    };
    p.points = computePoints(p);
    p.deliveries = p.small + p.medium + p.large;
    p.delValue = totalDeliveryValue(p);
    return p;
  });

  const totalPoints = players.reduce((a, p) => a + p.points, 0);
  const gross = players.reduce((a, p) => a + p.delValue, 0);
  const playerPool = gross * (1 - CAMP_CUT);
  const campRevenue = gross * CAMP_CUT;
  const valuePerPoint = totalPoints > 0 ? (playerPool / totalPoints) : 0;

  // payout + sort like your ranch board
  for (const p of players) p.payout = p.points * valuePerPoint;
  players.sort((a, b) => b.payout - a.payout || b.points - a.points);

  const embed = new EmbedBuilder()
    .setTitle(`🏕️ ${CAMP_NAME}`)
    .setDescription(
      `📅 Next Camp Payout: **${NEXT_PAYOUT_LABEL}**\n` +
      `Payout Mode: **Points (30% camp fee)**`
    )
    .setColor(0x2b2d31)
    .setFooter({
      text:
        `🧾 Total Delivery Value: $${Math.round(gross)} • ` +
        `💰 Camp Revenue: $${Math.round(campRevenue)} • ` +
        `⭐ Total Points: ${totalPoints}`,
    });

  // Compact 2-column ranked style
  const medals = ["🥇", "🥈", "🥉"];
  for (let i = 0; i < Math.min(players.length, 24); i++) {
    const p = players[i];
    const badge = medals[i] || `#${i + 1}`;

    embed.addFields({
      name: `${badge} ${p.tag}`,
      value:
        `🪨 **${p.material_sets}** mats\n` +
        `🚚 **${p.deliveries}** (S:${p.small} M:${p.medium} L:${p.large})\n` +
        `📦 **${p.supplies}** supplies\n` +
        `⭐ **${p.points}** pts\n` +
        `💰 **${fmtMoney(p.payout)}**`,
      inline: true,
    });
  }

  await msg.edit({ content: "", embeds: [embed] });
  console.log("📊 Camp board updated");
}

// ================= LIVE UPDATES =================
let debounce = null;
function scheduleUpdate() {
  if (debounce) return;
  debounce = setTimeout(async () => {
    debounce = null;
    await rebuildTotals();
    await updateCampBoard();
  }, 1500);
}

client.on("messageCreate", async (message) => {
  try {
    if (message.channel.id !== CAMP_INPUT_CHANNEL_ID) return;
    if (!message.webhookId && !message.author?.bot) return;

    const parsed = parseCampLog(message);
    if (!parsed) return;

    const ok = await insertEvent(message.id, parsed);
    if (ok) scheduleUpdate();
  } catch (e) {
    console.error("❌ messageCreate error:", e);
  }
});

// ================= STARTUP =================
client.once("clientReady", async () => {
  try {
    console.log(`🏕️ Camp Manager Online: ${client.user.tag}`);
    await ensureSchema();

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling camp history (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillFromHistory(BACKFILL_MAX_MESSAGES);
    }

    await rebuildTotals();
    await updateCampBoard();

    console.log("✅ Startup complete.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

client.login(BOT_TOKEN);
