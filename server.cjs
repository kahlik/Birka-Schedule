// server.cjs
// Birka Bowling & Dart — Sport-schema backend using TheSportsDB (CommonJS)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.THESPORTSDB_KEY || "3";
const BASE_URL = "https://www.thesportsdb.com/api/v1/json";

// Time offset: Sweden winter time = -60 min (API looks like summer time)
const TIME_OFFSET_MINUTES = -60;

// Approximate match duration before we consider it "finished"
const MATCH_DURATION_MINUTES = 120;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

console.log("Using TheSportsDB key:", API_KEY);

// ---------------------------
// PRIORITY + TAG STORAGE
// ---------------------------
const prioritiesPath = path.join(__dirname, "priorities.json");

function loadPriorities() {
  try {
    const raw = fs.readFileSync(prioritiesPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      eventIds: parsed.eventIds || [],
      tags: parsed.tags || {} // { [eventId]: ["BB1","BB3"] }
    };
  } catch (e) {
    return { eventIds: [], tags: {} };
  }
}

function savePriorities(data) {
  fs.writeFileSync(prioritiesPath, JSON.stringify(data, null, 2), "utf8");
}

let PRIORITIES = loadPriorities();

// ---------------------------
// ALLOWED LEAGUES
// ---------------------------
const ALLOWED_LEAGUES = [
  { id: 4347, name: "Allsvenskan",       seasonType: "single" },
  { id: 4328, name: "Premier League",    seasonType: "range"  },
  { id: 4480, name: "Champions League",  seasonType: "range"  },
  { id: 4570, name: "EFL Cup",           seasonType: "range"  },
  { id: 4429, name: "Fotbolls-VM",       seasonType: "range"  },
  { id: 4419, name: "SHL",               seasonType: "range"  },
  { id: 5162, name: "Hockeyallsvenskan", seasonType: "range"  },
  { id: 4370, name: "F1",                seasonType: "single" },
  { id: 4373, name: "IndyCar",           seasonType: "single" },
  { id: 4554, name: "Dart",              seasonType: "single" }
];

// ---------------------------
// CHANNEL MAPPING
// ---------------------------
const CHANNEL_RULES = [
  { test: /allsvenskan/i,                       channel: "Discovery+" },
  { test: /premier league/i,                    channel: "Viaplay / Viasat" },
  { test: /champions league/i,                  channel: "Viaplay / V Sport Fotboll" },
  { test: /\bshl\b/i,                           channel: "TV4" },
  { test: /hockeyallsvenskan/i,                 channel: "TV4" },
  { test: /\bf1\b|\bformula 1\b/i,              channel: "Viaplay / Viasat" },
  { test: /indycar/i,                           channel: "Viaplay / Viasat" },
  { test: /dart/i,                              channel: "Viaplay / Viasat" },
  { test: /fotbolls[- ]?vm|fifa world cup|vm/i, channel: "Viaplay" },
  { test: /efl cup|league cup/i,                channel: "Viaplay" }
];

function mapChannel(comp, text = "") {
  const combined = `${comp} ${text}`.toLowerCase();
  for (const rule of CHANNEL_RULES) {
    if (rule.test.test(combined)) return rule.channel;
  }
  return "";
}

// ---------------------------
// SEASON HELPERS
// ---------------------------
function getSeasonForLeague(league) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (league.seasonType === "single") return String(year);

  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

function getPreviousSeason(league, season) {
  if (league.seasonType === "single") return String(Number(season) - 1);

  const m = season.match(/(\d{4})-(\d{4})/);
  if (!m) return season;
  return `${Number(m[1]) - 1}-${Number(m[2]) - 1}`;
}

function addDaysISO(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------
// TIME OFFSET FIX (summer/winter)
// ---------------------------
function applyTimeOffset(dateStr, rawTime) {
  if (!rawTime) return { date: dateStr, time: "" };

  const [hStr, mStr] = rawTime.split(":");
  if (hStr == null || mStr == null) {
    return { date: dateStr, time: rawTime };
  }

  let minutesTotal = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
  minutesTotal += TIME_OFFSET_MINUTES;

  let base = new Date(dateStr + "T12:00:00Z");

  while (minutesTotal < 0) {
    minutesTotal += 1440;
    base.setUTCDate(base.getUTCDate() - 1);
  }
  while (minutesTotal >= 1440) {
    minutesTotal -= 1440;
    base.setUTCDate(base.getUTCDate() + 1);
  }

  const newDate = base.toISOString().slice(0, 10);
  const hh = String(Math.floor(minutesTotal / 60)).padStart(2, "0");
  const mm = String(minutesTotal % 60).padStart(2, "0");

  return { date: newDate, time: `${hh}:${mm}` };
}

// ---------------------------
// API FETCHER
// ---------------------------
async function fetchEventsForLeague(league) {
  const season = getSeasonForLeague(league);
  const url1 = `${BASE_URL}/${API_KEY}/eventsseason.php?id=${league.id}&s=${season}`;

  try {
    const r1 = await axios.get(url1);
    let events = r1.data.events || [];

    if (!events.length) {
      const prev = getPreviousSeason(league, season);
      const url2 = `${BASE_URL}/${API_KEY}/eventsseason.php?id=${league.id}&s=${prev}`;
      const r2 = await axios.get(url2);
      events = r2.data.events || [];
    }

    return events;
  } catch (e) {
    console.log("Fetch error", league.name, e.message);
    return [];
  }
}

// ---------------------------
// /schedule endpoint
// ---------------------------
app.get("/schedule", async (req, res) => {
  try {
    const now = new Date();
    const results = await Promise.all(ALLOWED_LEAGUES.map(fetchEventsForLeague));

    const dayMap = new Map();

    results.forEach((events, idx) => {
      const league = ALLOWED_LEAGUES[idx];

      events.forEach(ev => {
        const rawDate = ev.dateEvent || ev.dateEventLocal;
        const rawTime = ev.strTime ? ev.strTime.slice(0,5) : (ev.strTimeLocal ? ev.strTimeLocal.slice(0,5) : "");

        if (!rawDate) return;

        const { date: adjDate, time: adjTime } = applyTimeOffset(rawDate, rawTime);

        // Build Date object for match start
        let startDT = adjTime
          ? new Date(`${adjDate}T${adjTime}:00`)
          : new Date(`${adjDate}T12:00:00`);

        const endDT = new Date(startDT.getTime() + MATCH_DURATION_MINUTES * 60000);

        // Hide match if it's already finished
        if (endDT < now) return;

        if (!dayMap.has(adjDate)) dayMap.set(adjDate, { date: adjDate, matches: [] });

        const id = String(ev.idEvent || "");
        const isPriority = PRIORITIES.eventIds.includes(id);
        const tagsForId = Array.isArray(PRIORITIES.tags[id]) ? PRIORITIES.tags[id] : [];

        dayMap.get(adjDate).matches.push({
          id,
          time: adjTime,
          competition: league.name,
          home: ev.strHomeTeam || "",
          away: ev.strAwayTeam || "",
          channel: mapChannel(league.name, (ev.strHomeTeam || "") + (ev.strAwayTeam || "")),
          priority: isPriority,
          tags: tagsForId
        });
      });
    });

    // Convert to sorted array
    const allDays = Array.from(dayMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // Sort matches by time within each day
    allDays.forEach(day => {
      day.matches.sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });
    });

    if (!allDays.length) {
      return res.json({ generatedAt: new Date().toISOString(), days: [] });
    }

    // 14-day date window
    const today = new Date().toISOString().slice(0, 10);
    const end = addDaysISO(today, 13);

    let windowDays = allDays.filter(d => d.date >= today && d.date <= end);

    if (!windowDays.length) {
      const future = allDays.filter(d => d.date >= today);
      windowDays = future.length ? future.slice(0,14) : allDays.slice(0,14);
    }

    res.json({ generatedAt: new Date().toISOString(), days: windowDays });
  } catch (e) {
    console.error("schedule error", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------
// PRIORITY API
// ---------------------------
app.post("/priorities/toggle", express.json(), (req, res) => {
  const id = String(req.body.id || "");
  if (!id) return res.json({ ok:false });

  const idx = PRIORITIES.eventIds.indexOf(id);
  if (idx >= 0) PRIORITIES.eventIds.splice(idx,1);
  else PRIORITIES.eventIds.push(id);

  savePriorities(PRIORITIES);

  res.json({ ok:true, eventIds: PRIORITIES.eventIds });
});

// ---------------------------
// TAG API (BB1–BB4)
// ---------------------------
app.post("/tags/toggle", express.json(), (req, res) => {
  const id = String(req.body.id || "");
  const tag = req.body.tag;
  if (!id || !tag) return res.json({ ok:false });

  if (!PRIORITIES.tags) PRIORITIES.tags = {};
  if (!Array.isArray(PRIORITIES.tags[id])) PRIORITIES.tags[id] = [];

  const list = PRIORITIES.tags[id];
  const idx = list.indexOf(tag);
  if (idx >= 0) {
    list.splice(idx, 1); // remove
  } else {
    list.push(tag);      // add
  }

  savePriorities(PRIORITIES);

  res.json({ ok:true, tagsForId: PRIORITIES.tags[id] });
});

// ---------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log("Birka schema running at http://localhost:"+PORT));
