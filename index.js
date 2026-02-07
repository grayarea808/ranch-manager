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

// For exact screenshot math set these to 1.10
const RANCH_MILK_PRICE = Number(process.env.RANCH_MILK_PRICE || 1.25);
const RANCH_EGG_PRICE = Number(process.env.RANCH_EGG_PRICE || 1.25);

const PAGE_SIZE = Number(process.env.RANCH_PAGE_SIZE || 7);

// “Profit” line at bottom of screenshot.
// If you already have a profit formula, plug it in here.
// Default: profit = total cattle sales (common for “ranch profit”)
const PROFIT_MODE = (process.env.RANCH_PROFIT_MODE || "cattle").toLowerCase(); // cattle | none

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
      user_id BIGINT,
      kind TEXT,
      qty NUMERIC NOT NULL DEFAULT 0,
      amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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
// PARSE LOGS
// =====================
function parseUserId(text) {
  const m1 = text.match(/<@(\d{15,20})>/);
  if (m1) return m1[1];
  const m2 = text.match(/Discord:\s*@.*?(\d{15,20})/i);
  if (m2) return m2[1];
  const m3 = text.match(/@[\w\-\.\s]+\s+(\d{15,20})/);
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

  // Sales: "sold 5 Bison for 1200.0$"
  const sale = text.match(/sold\s+(\d+)\s+([A-Za-z ]+)\s+for\s+([\d.]+)\$/i);
  if (sale) return { user_id: userId, kind: "cattle_sale", qty: Number(sale[1]), amount: Number(sale[3]) };

  return null;
}

async function insertRanchEvent(messageId, evt, createdAtIso) {
  await pool.query(
    `
    INSERT INTO ranch_events(source_message_id, user_id, kind, qty, amount, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (source_message_id) DO NOTHING
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
    } catch {
      // deleted; recreate
    }
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
function nextSaturdayNoonET(from = new Date()) {
  // returns Date object (ET-ish display only; logic is UTC based but fine for “next payout” label)
  const d = new Date(from);
  const day = d.getUTCDay(); // 0=Sun
  // We want next Saturday
  const daysUntilSat = (6 - day + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilSat);
  // 12:00 PM ET ≈ 17:00 UTC (winter) / 16:00 UTC (summer). For label only:
  return d;
}
function fmtNextPayoutLabel() {
  // Just a label like the screenshot; doesn’t need exact time conversion
  const d = nextSaturdayNoonET(new Date());
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  return `Saturday, ${label}`;
}

async function ranchTotalsSince(weekStartIso) {
  const { rows } = await pool.query(
    `
    SELECT
      user_id,
      SUM(CASE WHEN kind='milk' THEN qty ELSE 0 END) AS milk,
      SUM(CASE WHEN kind='eggs' THEN qty ELSE 0 END) AS eggs,
      SUM(CASE WHEN kind='cattle_sale' THEN amount ELSE 0 END) AS cattle_amount
    FROM ranch_events
    WHERE created_at >= $1::timestamptz
      AND kind IS NOT NULL
    GROUP BY user_id
    `,
    [weekStartIso]
  );

  const users = rows.map((r) => {
    const milk = Number(r.milk || 0);
    const eggs = Number(r.eggs || 0);
    const cattle = Number(r.cattle_amount || 0);

    const milkPay = milk * RANCH_MILK_PRICE;
    const eggsPay = eggs * RANCH_EGG_PRICE;

    const total = milkPay + eggsPay + cattle;

    return {
      user_id: r.user_id,
      milk,
      eggs,
      cattle,
      milkPay,
      eggsPay,
      total,
    };
  });

  users.sort((a, b) => b.total - a.total);
  return users;
}

// =====================
// 1:1 EMBED LAYOUT (YOUR SCREENSHOT)
// =====================
function makeRanchEmbed({ users, page, totalPages }) {
  const start = page * PAGE_SIZE;
  const slice = users.slice(start, start + PAGE_SIZE);

  const totalMilk = users.reduce((a, u) => a + u.milk, 0);
  const totalEggs = users.reduce((a, u) => a + u.eggs, 0);
  const totalPayout = users.reduce((a, u) => a + u.total, 0);
  const totalProfit =
    PROFIT_MODE === "cattle"
      ? users.reduce((a, u) => a + u.cattle, 0)
      : 0;

  // Title matches exactly: "🏆 Baba Yaga Ranch — Page 1/1"
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${RANCH_NAME} — Page ${page + 1}/${Math.max(totalPages, 1)}`)
    // Next payout line is in the embed description (like screenshot)
    .setDescription(`📅 Next Ranch Payout: ${fmtNextPayoutLabel()}`);

  // Top “columns”: payout + totals
  embed.addFields(
    { name: "💰 Ranch Payout", value: `**${money(totalPayout)}**`, inline: true },
    { name: "🥛", value: `**${totalMilk.toLocaleString()}**`, inline: true },
    { name: "🥚", value: `**${totalEggs.toLocaleString()}**`, inline: true }
  );

  // Player blocks: inline fields -> Discord shows 3 columns
  for (const u of slice) {
    const value = [
      `🥛 Milk: ${u.milk} -> ${money(u.milkPay)}`,
      `🥚 Eggs: ${u.eggs} -> ${money(u.eggsPay)}`,
      `🐄 Cattle: ${money(u.cattle)}`,
      `💰 **Total: ${money(u.total)}**`,
    ].join("\n");

    // name should show their Discord tag/mention exactly like the screenshot
    embed.addFields({
      name: `<@${u.user_id}>`,
      value,
      inline: true,
    });
  }

  embed.setFooter({ text: `Total Ranch Profit: ${money(totalProfit)} • Today at ${etNow()}` });
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
  const weekStartIso = (await getState("ranch_week_start")) || new Date().toISOString();
  const users = await ranchTotalsSince(weekStartIso);

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
// BUTTON INTERACTIONS
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId !== "ranch_prev" && interaction.customId !== "ranch_next") return;

  try {
    await interaction.deferUpdate();

    const weekStartIso = (await getState("ranch_week_start")) || new Date().toISOString();
    const users = await ranchTotalsSince(weekStartIso);
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
  const msgs = await channel.messages.fetch({ limit: 100 });

  let inserted = 0;
  for (const [, m] of msgs) {
    const content = (m.content || "").trim();
    if (!content) continue;

    const evt = parseRanchLog(content);
    if (!evt) continue;

    try {
      await insertRanchEvent(m.id, evt, m.createdAt?.toISOString());
      inserted++;
    } catch {}
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

      const evt = parseRanchLog(content);
      if (!evt) continue;

      try {
        await insertRanchEvent(m.id, evt, m.createdAt?.toISOString());
        inserted++;
      } catch {}

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

    if (!(await getState("ranch_week_start"))) {
      await setState("ranch_week_start", new Date().toISOString());
    }
    if (!(await getState("ranch_page"))) {
      await setState("ranch_page", 0);
    }

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
