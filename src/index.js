import axios from "axios";

// ====== KONFIG (możesz edytować) ======
const TIMEZONE = "Europe/Warsaw";
const MAX_LEN = 3900;
const EXTRA_TAGS = "#XAU #XAG #NAS100";
const IMPACT_ICON = "★★★"; // HIGH

const ALLOWED = new Set(["USD","EUR","GBP","JPY","CHF","CAD","AUD","NZD"]);

const FEED_THIS = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const FEED_NEXT = "https://nfs.faireconomy.media/ff_calendar_nextweek.xml";

// Założenie strefy czasu feedu (najbezpieczniej zostawić UTC)
const FEED_TIMEZONE = "UTC";

// ====== SECRETS z GitHub Actions / ENV ======
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!botToken) throw new Error("Brak TELEGRAM_BOT_TOKEN w env/secrets.");
if (!chatId) throw new Error("Brak TELEGRAM_CHAT_ID w env/secrets.");

// ====== TŁUMACZENIA + OPISY (1 zdanie) ======
const PL_MAP = [
  [/^CPI m\/m$/i, { pl: "CPI m/m (inflacja, zmiana m/m)", tip: "Pokazuje jak zmieniają się ceny konsumenckie miesiąc do miesiąca." }],
  [/^CPI y\/y$/i, { pl: "CPI r/r (inflacja, zmiana r/r)", tip: "Pokazuje roczne tempo inflacji konsumenckiej." }],
  [/^Trimmed Mean CPI m\/m$/i, { pl: "CPI Trimmed Mean m/m (inflacja bazowa)", tip: "Miara inflacji po odcięciu skrajnych zmian cen." }],
  [/^Unemployment Claims$/i, { pl: "Wnioski o zasiłek dla bezrobotnych", tip: "Sygnał kondycji rynku pracy w krótkim terminie." }],
  [/^GDP m\/m$/i, { pl: "PKB m/m", tip: "Informuje o zmianie aktywności gospodarczej w ujęciu miesiąc do miesiąca." }],
  [/^Core PPI m\/m$/i, { pl: "Bazowy PPI m/m", tip: "Inflacja po stronie producentów bez najbardziej zmiennych składników." }],
  [/^PPI m\/m$/i, { pl: "PPI m/m", tip: "Zmiana cen producentów — często wyprzedza CPI." }],
  [/^President .* Speaks$/i, { pl: "Wystąpienie prezydenta", tip: "Wystąpienia mogą wpływać na sentyment i oczekiwania rynku." }],
  [/^Interest Rate Decision$/i, { pl: "Decyzja ws. stóp procentowych", tip: "Zmiana stóp wpływa na walutę i rynki poprzez koszt pieniądza." }],
  [/^FOMC Statement$/i, { pl: "Komunikat FOMC", tip: "Rynek szuka wskazówek co do przyszłej polityki Fed." }],
  [/^Non-Farm Employment Change$/i, { pl: "Zmiana zatrudnienia poza rolnictwem (NFP)", tip: "Jeden z najważniejszych raportów o rynku pracy w USA." }],
];

const translatePL = (title) => {
  for (const [re, obj] of PL_MAP) if (re.test(title)) return obj;
  return { pl: "—", tip: "—" };
};

// ====== HELPERS ======
const stripCdata = (s) =>
  (s || "")
    .replace("<![CDATA[", "")
    .replace("]]>", "")
    .trim();

const getBetween = (block, open, close) => {
  const a = block.indexOf(open);
  const b = block.indexOf(close);
  if (a === -1 || b === -1 || b <= a) return "";
  return block.substring(a + open.length, b).trim();
};

const getTag = (block, tag) => stripCdata(getBetween(block, `<${tag}>`, `</${tag}>`));

const ymdToDateUTC = (ymd) => new Date(ymd + "T00:00:00Z");
const formatYMD = (d) => d.toISOString().slice(0, 10);

const addDaysUTC = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

const warsawTodayYMD = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const dayOfWeekWarsaw = () => {
  const d = new Date();
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short" }).format(d);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
};

const weekWindow = () => {
  const todayYMD = warsawTodayYMD();
  const today = ymdToDateUTC(todayYMD);
  const wd = dayOfWeekWarsaw(); // Sun=0..Sat=6

  // sobota → następny tydzień (pon-nd)
  if (wd === 6) {
    const start = addDaysUTC(today, 2); // next Monday
    const end = addDaysUTC(start, 6);   // next Sunday
    return { start, end, mode: "next" };
  }

  // inne dni → dziś do niedzieli
  const start = new Date(today);
  const end = addDaysUTC(today, (7 - wd - 1));
  return { start, end, mode: "this" };
};

const withinWindow = (ymd, start, end) => {
  if (!ymd) return false;
  const d = ymdToDateUTC(ymd);
  return d >= start && d <= end;
};

const cleanTime = (t) => stripCdata(t);

const flagFor = (cur) =>
  ({
    USD: "🇺🇸",
    EUR: "🇪🇺",
    GBP: "🇬🇧",
    JPY: "🇯🇵",
    CHF: "🇨🇭",
    CAD: "🇨🇦",
    AUD: "🇦🇺",
    NZD: "🇳🇿",
  }[cur] || "🏳️");

const splitTelegram = (text) => {
  if (text.length <= MAX_LEN) return [text];
  const lines = text.split("\n");
  const out = [];
  let buf = "";
  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > MAX_LEN) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
};

// Minimalny escape, bo parse_mode=HTML
const escapeHtml = (s) =>
  (s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const send = async (text) => {
  await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
};

// ---- Konwersja czasu feed -> Warszawa (FEED_TIMEZONE=UTC) ----
const parseTime12h = (t) => {
  // "1:30pm" / "12:30am"
  const m = (t || "").match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === "am") {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }
  return { hh, mm };
};

const formatHHMM = (hh, mm) => `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

const toWarsawTime = (ymd, time12h) => {
  const p = parseTime12h(time12h);
  if (!p || !ymd) return null;

  if (FEED_TIMEZONE !== "UTC") return null; // trzymamy prosto i stabilnie

  const dt = new Date(`${ymd}T${formatHHMM(p.hh, p.mm)}:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const h = parts.find((x) => x.type === "hour")?.value;
  const m = parts.find((x) => x.type === "minute")?.value;
  if (!h || !m) return null;
  return `${h}:${m}`;
};

// ====== ŚWIĘTA PL (stałe + ruchome) ======
const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar,4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
};

const polishHolidays = (year) => {
  const fixed = {
    [`${year}-01-01`]: "🎉 Nowy Rok",
    [`${year}-01-06`]: "✝️ Trzech Króli",
    [`${year}-05-01`]: "🇵🇱 Święto Pracy",
    [`${year}-05-03`]: "🇵🇱 Święto Konstytucji 3 Maja",
    [`${year}-08-15`]: "⛪ Wniebowzięcie NMP",
    [`${year}-11-01`]: "🕯️ Wszystkich Świętych",
    [`${year}-11-11`]: "🇵🇱 Narodowe Święto Niepodległości",
    [`${year}-12-25`]: "🎄 Boże Narodzenie (1 dzień)",
    [`${year}-12-26`]: "🎄 Boże Narodzenie (2 dzień)",
  };

  const easter = easterSunday(year);
  const easterYMD = formatYMD(easter);
  const easterMon = formatYMD(addDaysUTC(easter, 1));
  const corpusChristi = formatYMD(addDaysUTC(easter, 60));

  fixed[easterYMD] = "🐣 Wielkanoc";
  fixed[easterMon] = "🐣 Poniedziałek Wielkanocny";
  fixed[corpusChristi] = "⛪ Boże Ciało";

  return fixed;
};

async function main() {
  // ====== WYBIERZ FEED ======
  const { start, end, mode } = weekWindow();
  const startStr = formatYMD(start);
  const endStr = formatYMD(end);
  const feedUrl = mode === "next" ? FEED_NEXT : FEED_THIS;

  // ====== POBIERZ XML ======
  const resp = await axios.get(feedUrl, {
    responseType: "text",
    headers: {
      "User-Agent": "Mozilla/5.0 (GitHubActions; ForexCalendarBot)",
      "Accept": "application/xml,text/xml,text/plain,*/*",
    },
    timeout: 30_000,
  });

  const xml = typeof resp?.data === "string" ? resp.data : null;
  if (!xml) {
    await send("❌ Nie udało się pobrać XML (pusty response).");
    return;
  }

  // ====== PARSE ======
  const events = [];
  const blocks = xml.split("<event>").slice(1);

  for (const blockRaw of blocks) {
    const block = blockRaw.split("</event>")[0];

    const titleRaw = getTag(block, "title");
    const impact = getTag(block, "impact");
    const date = getTag(block, "date"); // np. 02-25-2026
    const time = getTag(block, "time"); // np. 12:30am

    let currency = getTag(block, "currency") || getTag(block, "cur") || "";
    currency = (currency || "").trim().toUpperCase();

    const isHigh = (impact || "").toLowerCase().includes("high");

    let ymd = "";
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      const [mm, dd, yyyy] = date.split("-");
      ymd = `${yyyy}-${mm}-${dd}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ymd = date;
    }

    if (!isHigh) continue;
    if (!withinWindow(ymd, start, end)) continue;
    if (currency && currency.length === 3 && !ALLOWED.has(currency)) continue;

    const pl = translatePL(titleRaw);
    const plTime = toWarsawTime(ymd, time);

    events.push({
      title: titleRaw,
      currency,
      ymd,
      timeRaw: cleanTime(time),
      timePL: plTime,
      plLine: pl.pl,
      tip: pl.tip,
    });
  }

  events.sort(
    (a, b) =>
      (a.ymd || "").localeCompare(b.ymd || "") ||
      (a.timeRaw || "").localeCompare(b.timeRaw || "")
  );

  // ====== ZBUDUJ LISTĘ DNI W OKNIE ======
  const days = [];
  for (let d = new Date(start); d <= end; d = addDaysUTC(d, 1)) days.push(formatYMD(d));

  const holidays = polishHolidays(parseInt(startStr.slice(0, 4), 10));

  // ====== WIADOMOŚĆ ======
  let msg =
    `📅 <b>Kalendarz makroekonomiczny — wydarzenia o wysokim wpływie</b>\n` +
    `<i>${startStr} → ${endStr} (Warszawa)</i>\n` +
    `Waluty: <b>AUD CAD CHF EUR GBP JPY NZD USD</b>\n` +
    `${EXTRA_TAGS}\n\n`;

  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.ymd)) byDay.set(e.ymd, []);
    byDay.get(e.ymd).push(e);
  }

  for (const day of days) {
    msg += `🗓 <b>${day}</b>\n`;

    if (holidays[day]) msg += `🇵🇱 <i>${escapeHtml(holidays[day])} (PL — dzień wolny)</i>\n`;

    const list = byDay.get(day) || [];
    if (!list.length) {
      msg += `— brak wydarzeń ${IMPACT_ICON}\n\n`;
      continue;
    }

    for (const e of list) {
      const curLabel = e.currency ? `${flagFor(e.currency)} ${e.currency}` : "🌍";
      const timeLeft = e.timeRaw || "--:--";

      msg += `${IMPACT_ICON} <b>${escapeHtml(timeLeft)}</b>  ${curLabel} — <b>${escapeHtml(e.title)}</b>\n`;

      const plTime = e.timePL ? `🇵🇱 ${escapeHtml(e.timePL)}` : "🇵🇱 —";
      msg += `<i>${plTime} | ${escapeHtml(e.plLine)}</i>\n`;

      if (e.tip && e.tip !== "—") msg += `💡 <i>${escapeHtml(e.tip)}</i>\n`;
      msg += `\n`;
    }
  }

  msg += `#forex #kalendarz #highimpact #calendar #economic ${EXTRA_TAGS}`;

  // ====== WYŚLIJ ======
  const parts = splitTelegram(msg);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : "";
    await send(prefix + parts[i]);
  }

  console.log(JSON.stringify({
    ok: true,
    feedUrl,
    mode,
    window: { start: startStr, end: endStr },
    high: events.length,
    parts: parts.length,
  }, null, 2));
}

main().catch(async (err) => {
  console.error(err);
  try {
    await send(`❌ Błąd skryptu: <code>${escapeHtml(err?.message || String(err))}</code>`);
  } catch {}
  process.exit(1);
});