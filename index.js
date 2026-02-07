import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import pg from "pg";

// =====================
// ENV
// =====================
const PORT = process.env.PORT || 8080;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const RANCH_INPUT_CHANNEL_ID = process.env.RANCH_INPUT_CHANNEL_ID;
const RANCH_OUTPUT_CHANNEL_ID = process.env.RANCH_OUTPUT_CHANNEL_ID;

const LEADERBOARD_DEBOUNCE_MS = Number(process.env.LEADERBOARD_DEBOUNCE_MS || 2000);
const POLL_EVERY_MS = Number(process.env.BACKFILL_EVERY_MS || 300000);

const BACKFILL_ON_START = String(process.env.BACKFILL_ON_START || "true") === "true";
const BACKFILL_MAX_MESSAGES = Number(process.env.BACKFILL_MAX_MESSAGES || 300);

const RANCH_NAME = process.env.RANCH_NAME || "Beaver Falls Ranch";

// prices
const RANCH_MILK_PRICE = Number(process.env.RANCH_MILK_PRICE || 1.25);
const RANCH_EGG_PRICE = Number(process.env.RANCH_EGG_PRICE || 1.25);

const PAGE_SIZE = Number(process.env.RANCH_PAGE_SIZE || 7);

function must(name) {
  if (!process.env[name]) throw new Error(`❌ Missing Railway variable: ${name}`);
}
["DISCORD_TOKEN", "DATABASE_URL", "RANCH_INPUT_CHANNEL_ID", "RANCH_OUTPUT_CHANNEL_ID"].forEach(must);

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
// DB
// =====================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranch_events (
      id BIGSERIAL PRIMARY KEY,
      source_message_id BIGINT,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='ranch_events' AND indexname='ranch_events_source_message_id_kind_uq'
      ) THEN
        CREATE UNIQUE INDEX ranch_events_source_message_id_kind_uq
          ON ranch_events(source_message_id, kind)
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
    `
    INSERT INTO bot_state(key,value) VALUES($1,$2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,
    [key, String(value)]
  );
}

// =====================
// PARSE LOGS (FIXED FOR YOUR FORMAT)
// =====================

function parseUserIdFromContent(content) {
  // 1) <@123>
  const m1 = content.match(/<@(\d{15,20})>/);
  if (m1) return m1[1];

  // 2) "Discord: @Name 123..."
  const m2 = content.match(/Discord:\s*@.*?(\d{15,20})/i);
  if (m2) return m2[1];

  // 3) "@Name 757902520529059842 something"
  // grabs the first long snowflake-like number after an @name
  const m3 = content.match(/@\S[\s\S]{0,80}?(\d{15,20})/);
  if (m3) return m3[1];

  // 4) any standalone snowflake in message
  const m4 = content.match(/\b(\d{15,20})\b/);
  if (m4) return m4[1];

  return null;
}

function parseRanchMessage(content) {
  const userId = parseUserIdFromContent(content);
  if (!userId) return [];

  const events = [];

  // IMPORTANT: your message can include BOTH milk and eggs lines in the same message
  const milkMatch = content.match(/Added\s+Milk\s+to\s+ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (milkMatch) events.push({ user_id: userId, kind: "milk", qty: Number(milkMatch[1]), amount: 0 });

  const eggsMatch = content.match(/Added\s+Eggs\s+to\s+ranch\s+id\s+\d+\s*:\s*(\d+)/i);
  if (eggsMatch) events.push({ user_id: userId, kind: "eggs", qty: Number(eggsMatch[1]), amount: 0 });

  // optional cattle sale if you want it later
  const sale = content.match(/sold\s+(\d+)\s+[A-Za-z ]+\s+for\s+([\d.]+)\$/i);
  if (sale) events.push({ user_id: userId, kind: "cattle_sale", qty: Number(sale[1]), amount: Number(sale[2]) });

  return events;
}

async function insertRanchEvent(messageId, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO ranch_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id, kind) DO NOTHING
    `,
    [
      String(messageId),
      String(evt.user_id),
      evt.kind,
      evt.qty,
      evt.amount,
      createdAtIso || new Date().toISOString(),
    ]
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

async function ensureSingleMessage(channelId, stateKey, initialPayload) {
  const ch = await fetchChannel(channelId);
  let msgId = await getState(stateKey);

  if (msgId) {
    try {
      return await ch.messages.fetch(msgId);
    } catch {}
  }

  const msg = await ch.send(initialPayload);
  await setState(stateKey, msg.id);
  return msg;
}

// =====================
// MATH + FORMATTING
// =====================
function money(n) {
  return `$${Number(n).toFixed(2)}`;
}
function etNow() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
}
function fmtNextPayoutLabel() {
  // simple label
  const now = new Date();
  // next Saturday
  const d = new Date(now);
  const day = d.getDay(); // local; ok for label
  const diff = (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

async function ranchTotals() {
  const { rows } = await pool.query(`
    SELECT
      user_id,
      SUM(CASE WHEN kind='milk' THEN qty ELSE 0 END) AS milk,
      SUM(CASE WHEN kind='eggs' THEN qty ELSE 0 END) AS eggs
    FROM ranch_events
    GROUP BY user_id
  `);

  const users = rows.map((r) => {
    const milk = Number(r.milk || 0);
    const eggs = Number(r.eggs || 0);
    const milkPay = milk * RANCH_MILK_PRICE;
    const eggsPay = eggs * RANCH_EGG_PRICE;
    const total = milkPay + eggsPay;
    return { user_id: r.user_id, milk, eggs, milkPay, eggsPay, total };
  });

  users.sort((a, b) => b.total - a.total);
  return users;
}

// =====================
// EMBED LAYOUT
// =====================
function makeRanchEmbed({ users, page, totalPages }) {
  const start = page * PAGE_SIZE;
  const slice = users.slice(start, start + PAGE_SIZE);

  const totalMilk = users.reduce((a, u) => a + u.milk, 0);
  const totalEggs = users.reduce((a, u) => a + u.eggs, 0);
  const totalPayout = users.reduce((a, u) => a + u.total, 0);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${RANCH_NAME} — Page ${page + 1}/${Math.max(totalPages, 1)}`)
    .setDescription(`📅 Next Ranch Payout: ${fmtNextPayoutLabel()}`);

  embed.addFields(
    { name: "💰 Ranch Payout", value: `**${money(totalPayout)}**`, inline: true },
    { name: "🥛", value: `**${totalMilk.toLocaleString()}**`, inline: true },
    { name: "🥚", value: `**${totalEggs.toLocaleString()}**`, inline: true }
  );

  for (const u of slice) {
    const value = [
      `🥛 Milk: ${u.milk} -> ${money(u.milkPay)}`,
      `🥚 Eggs: ${u.eggs} -> ${money(u.eggsPay)}`,
      `💰 **Total: ${money(u.total)}**`,
    ].join("\n");

    embed.addFields({
      name: `<@${u.user_id}>`,
      value,
      inline: true,
    });
  }

  embed.setFooter({ text: `Total Ranch Profit: ${money(0)} • Today at ${etNow()}` });
  return embed;
}

function makePagerRow(page, totalPages) {
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ranch_prev")
      .setLabel("◀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId("ranch_next")
      .setLabel("▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextDisabled)
  );
}

// =====================
// RENDER / UPDATE
// =====================
let ranchEditTimer = null;

async function renderRanchBoard() {
  const users = await ranchTotals();
  const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));

  let page = Number((await getState("ranch_page")) || 0);
  if (Number.isNaN(page) || page < 0) page = 0;
  if (page > totalPages - 1) page = totalPages - 1;
  await setState("ranch_page", page);

  const msg = await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
    embeds: [new EmbedBuilder().setTitle("Loading…")],
    components: [],
  });

  const embed = makeRanchEmbed({ users, page, totalPages });
  const row = makePagerRow(page, totalPages);

  await msg.edit({ embeds: [embed], components: [row] });
}

function scheduleRanchUpdate() {
  clearTimeout(ranchEditTimer);
  ranchEditTimer = setTimeout(async () => {
    try {
      await renderRanchBoard();
    } catch (e) {
      console.error("❌ renderRanchBoard error:", e?.message || e);
    }
  }, LEADERBOARD_DEBOUNCE_MS);
}

// =====================
// BUTTONS
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "ranch_prev" && interaction.customId !== "ranch_next") return;

  try {
    await interaction.deferUpdate();

    const users = await ranchTotals();
    const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));

    let page = Number((await getState("ranch_page")) || 0);
    if (interaction.customId === "ranch_prev") page = Math.max(0, page - 1);
    if (interaction.customId === "ranch_next") page = Math.min(totalPages - 1, page + 1);

    await setState("ranch_page", page);

    const embed = makeRanchEmbed({ users, page, totalPages });
    const row = makePagerRow(page, totalPages);

    const msg = await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
      embeds: [new EmbedBuilder().setTitle("Loading…")],
      components: [],
    });

    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error("❌ pager error:", e?.message || e);
  }
});

// =====================
// POLL + BACKFILL
// =====================
async function pollRanchOnce() {
  const channel = await fetchChannel(RANCH_INPUT_CHANNEL_ID);
  const msgs = await channel.messages.fetch({ limit: 50 });

  let inserted = 0;

  for (const [, m] of msgs) {
    const content = (m.content || "").trim();
    if (!content) continue;

    const events = parseRanchMessage(content);
    if (!events.length) continue;

    for (const evt of events) {
      try {
        await insertRanchEvent(m.id, evt, m.createdAt?.toISOString());
        inserted++;
      } catch {}
    }
  }

  console.log(`RANCH poll fetched=${msgs.size} inserted~=${inserted}`);
}

async function backfillRanch(maxMessages) {
  const channel = await fetchChannel(RANCH_INPUT_CHANNEL_ID);
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

      const events = parseRanchMessage(content);
      if (!events.length) continue;

      for (const evt of events) {
        try {
          await insertRanchEvent(m.id, evt, m.createdAt?.toISOString());
          inserted++;
        } catch {}
      }

      if (scanned >= maxMessages) break;
    }
  }

  console.log(`📥 RANCH backfill scanned=${scanned} inserted~=${inserted}`);
}

// =====================
// STARTUP
// =====================
client.once("clientReady", async () => {
  try {
    console.log(`🤖 Online as ${client.user.tag}`);
    await ensureTables();

    if (!(await getState("ranch_page"))) await setState("ranch_page", 0);

    await ensureSingleMessage(RANCH_OUTPUT_CHANNEL_ID, "ranch_board_msg", {
      embeds: [new EmbedBuilder().setTitle("Loading…")],
      components: [],
    });

    if (BACKFILL_ON_START) {
      console.log(`📥 Backfilling ranch (max ${BACKFILL_MAX_MESSAGES})...`);
      await backfillRanch(BACKFILL_MAX_MESSAGES);
    }

    await renderRanchBoard();

    setInterval(async () => {
      try {
        await pollRanchOnce();
        scheduleRanchUpdate();
      } catch (e) {
        console.error("❌ poll loop error:", e?.message || e);
      }
    }, POLL_EVERY_MS);

    console.log("✅ Running.");
  } catch (e) {
    console.error("❌ Startup failed:", e);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`🚀 Web listening on ${PORT}`));
