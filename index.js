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
  console.error("❌ Missing required Railway variables.");
  process.exit(1);
}

const BACKFILL_ON_START = true;
const BACKFILL_MAX_MESSAGES = 5000;

// Delivery values
const DELIVERY_VALUES = {
  small: 500,
  medium: 950,
  large: 1500,
};

const SALE_VALUE_TO_TIER = {
  500: "small",
  950: "medium",
  1500: "large",
  1900: "large",
};

const CAMP_CUT = 0.30;
const MATERIAL_POINTS = 2;
const DELIVERY_POINTS = 3;
const SUPPLY_POINTS = 1;

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= EXPRESS =================
const app = express();
app.get("/", (_, res) => res.status(200).send("Camp Tracker running ✅"));
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Web listening on ${PORT}`)
);

// ================= DISCORD =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ================= SCHEMA =================
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.bot_messages (
      key TEXT PRIMARY KEY,
      channel_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
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

// ================= UTIL =================
function extractAllText(message) {
  let text = message.content || "";
  if (message.embeds?.length) {
    for (const e of message.embeds) {
      if (e.description) text += `\n${e.description}`;
      if (e.fields) {
        for (const f of e.fields) text += `\n${f.value}`;
      }
    }
  }
  return text;
}

function extractUserId(text) {
  const m = text.match(/Discord:\s*@\S+\s+(\d{17,19})/i);
  if (m) return m[1];
  const any = text.match(/\b(\d{17,19})\b/);
  return any ? any[1] : null;
}

function parseCampLog(message) {
  const text = extractAllText(message);
  const userId = extractUserId(text);
  if (!userId) return null;

  const sup = text.match(/Delivered Supplies:\s*(\d+)/i);
  if (sup) return { userId, item: "supplies", amount: Number(sup[1]) };

  const mat = text.match(/Materials added:\s*([0-9]+)/i);
  if (mat) return { userId, item: "materials", amount: Number(mat[1]) };

  const sale = text.match(/Made a Sale Of\s+\d+\s+Of Stock For\s+\$([0-9]+)/i);
  if (sale) {
    const tier = SALE_VALUE_TO_TIER[Number(sale[1])];
    if (tier) return { userId, item: tier, amount: 1 };
  }

  return null;
}

// ================= DB OPS =================
async function insertEvent(id, parsed) {
  await pool.query(`
    INSERT INTO public.camp_events (discord_message_id, user_id, item, amount)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (discord_message_id) DO NOTHING
  `, [id, parsed.userId, parsed.item, parsed.amount]);
}

async function rebuildTotals() {
  await pool.query(`TRUNCATE public.camp_totals`);

  await pool.query(`
    INSERT INTO public.camp_totals (user_id, material_sets, supplies, small, medium, large)
    SELECT
      user_id,
      SUM(CASE WHEN item='materials' THEN amount ELSE 0 END),
      SUM(CASE WHEN item='supplies' THEN amount ELSE 0 END),
      SUM(CASE WHEN item='small' THEN amount ELSE 0 END),
      SUM(CASE WHEN item='medium' THEN amount ELSE 0 END),
      SUM(CASE WHEN item='large' THEN amount ELSE 0 END)
    FROM public.camp_events
    GROUP BY user_id
  `);
}

// ================= DISPLAY HELPERS =================
async function getDiscordTag(userId) {
  try {
    const user = await client.users.fetch(userId);
    return `@${user.username}`;
  } catch {
    return `<@${userId}>`;
  }
}

function computePoints(p) {
  return (p.material_sets * MATERIAL_POINTS) +
         ((p.small + p.medium + p.large) * DELIVERY_POINTS) +
         (p.supplies * SUPPLY_POINTS);
}

function deliveryValue(p) {
  return (p.small * DELIVERY_VALUES.small) +
         (p.medium * DELIVERY_VALUES.medium) +
         (p.large * DELIVERY_VALUES.large);
}

// ================= BOARD =================
async function updateCampBoard() {
  const channel = await client.channels.fetch(CAMP_OUTPUT_CHANNEL_ID);
  let msg;
  const { rows } = await pool.query(`SELECT message_id FROM public.bot_messages WHERE key='camp_board'`);
  if (rows.length) {
    msg = await channel.messages.fetch(rows[0].message_id);
  } else {
    msg = await channel.send("Loading...");
    await pool.query(`
      INSERT INTO public.bot_messages (key, channel_id, message_id)
      VALUES ('camp_board',$1,$2)
    `, [CAMP_OUTPUT_CHANNEL_ID, msg.id]);
  }

  const data = await pool.query(`SELECT * FROM public.camp_totals`);
  const players = [];

  for (const r of data.rows) {
    const p = {
      user_id: r.user_id.toString(),
      material_sets: Number(r.material_sets),
      supplies: Number(r.supplies),
      small: Number(r.small),
      medium: Number(r.medium),
      large: Number(r.large),
    };
    p.points = computePoints(p);
    p.value = deliveryValue(p);
    players.push(p);
  }

  const gross = players.reduce((a,p)=>a+p.value,0);
  const poolValue = gross*(1-CAMP_CUT);
  const totalPoints = players.reduce((a,p)=>a+p.points,0);
  players.forEach(p=>{
    p.payout = totalPoints>0 ? (p.points/totalPoints)*poolValue : 0;
  });

  players.sort((a,b)=>b.payout-a.payout);

  const embed = new EmbedBuilder()
    .setTitle("🏕️ Baba Yaga Camp")
    .setDescription("Payout Mode: Points (30% camp fee)")
    .setColor(0x2b2d31);

  const medals=["🥇","🥈","🥉"];

  for(let i=0;i<players.length;i++){
    const p=players[i];
    const tag=await getDiscordTag(p.user_id);
    const medal=medals[i]||`#${i+1}`;
    embed.addFields({
      name:`${medal} ${tag}`,
      value:
        `🪨 Materials: ${p.material_sets}\n`+
        `🚚 Deliveries: ${p.small+p.medium+p.large}\n`+
        `📦 Supplies: ${p.supplies}\n`+
        `⭐ Points: ${p.points}\n`+
        `💰 $${p.payout.toFixed(2)}`,
      inline:true
    });
  }

  embed.setFooter({
    text:`🧾 Total Delivery Value: $${gross.toFixed(0)} • 💰 Camp Revenue: $${(gross*CAMP_CUT).toFixed(0)}`
  });

  await msg.edit({content:"",embeds:[embed]});
}

// ================= STARTUP =================
client.once("clientReady", async ()=>{
  console.log(`🏕️ Camp Manager Online: ${client.user.tag}`);
  await ensureSchema();

  if(BACKFILL_ON_START){
    const channel=await client.channels.fetch(CAMP_INPUT_CHANNEL_ID);
    const messages=await channel.messages.fetch({limit:BACKFILL_MAX_MESSAGES});
    for(const msg of messages.values()){
      if(!msg.webhookId&&!msg.author?.bot) continue;
      const parsed=parseCampLog(msg);
      if(parsed) await insertEvent(msg.id,parsed);
    }
  }

  await rebuildTotals();
  await updateCampBoard();
});

client.login(BOT_TOKEN);
