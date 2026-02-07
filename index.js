function tzOffsetMinutes(date, timeZone) {
  // Uses GMT offset like "GMT-5" / "GMT-4"
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(date);

  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
  if (!m) return 0;

  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2] || 0);
  const mm = Number(m[3] || 0);
  return sign * (hh * 60 + mm);
}

function zonedTimeToUtcDate({ year, month, day, hour, minute }, timeZone) {
  // Convert a "local time in timeZone" into a real JS Date (UTC instant).
  // 2-pass to handle DST boundaries.
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = new Date(localAsUtcMs);
  let off1 = tzOffsetMinutes(guess, timeZone);
  let utcMs = localAsUtcMs - off1 * 60_000;

  let off2 = tzOffsetMinutes(new Date(utcMs), timeZone);
  if (off2 !== off1) {
    utcMs = localAsUtcMs - off2 * 60_000;
  }
  return new Date(utcMs);
}

function getTzParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  // obj.weekday like "Sat"
  return obj;
}

function dowFromShort(short) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}

function addDaysYMD(year, month, day, addDays) {
  // Safe Y/M/D add using UTC math
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0); // noon avoids DST midnight weirdness
  const d = new Date(ms + addDays * 24 * 60 * 60 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nextSaturdayNoonLabelET(timeZone = "America/New_York") {
  const now = new Date();
  const p = getTzParts(now, timeZone);

  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);

  const dow = dowFromShort(p.weekday); // 0=Sun..6=Sat
  let daysUntilSat = (6 - dow + 7) % 7;

  // If it's already Saturday and we're at/after noon, next payout is next Saturday
  const isSat = daysUntilSat === 0;
  const atOrAfterNoon = hour > 12 || (hour === 12 && minute >= 0);
  if (isSat && atOrAfterNoon) daysUntilSat = 7;

  const targetYMD = addDaysYMD(year, month, day, daysUntilSat);

  const targetUtcDate = zonedTimeToUtcDate(
    { ...targetYMD, hour: 12, minute: 0 },
    timeZone
  );

  // Format exactly like: "Saturday, Feb 7"
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(targetUtcDate);
}
