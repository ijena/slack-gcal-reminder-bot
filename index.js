// Load environment variables from .env
require("dotenv").config();

const express = require("express");
const { WebClient } = require("@slack/web-api");
const { google } = require("googleapis");
const cron = require("node-cron");
const path = require("path");



const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Slack–Google Calendar reminder bot is running.");
});

app.listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});



const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;



const keyPath = path.join(__dirname, "service-account-key.json");
const serviceAccount = require(keyPath);
console.log("Loaded service account email:", serviceAccount.client_email);
console.log("Has private_key:", !!serviceAccount.private_key);


const jwtClient = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
});


const calendar = google.calendar({ version: "v3", auth: jwtClient });



// // Minutes in a week and a day
// const WEEK_MIN = 7 * 24 * 60; // 10080
// const DAY_MIN = 24 * 60;      // 1440

const TIMEZONE = "America/Los_Angeles";

function ymdInTZ(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA",{timeZone, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(date);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}


let googleAuthed = false;
async function getUpcomingEvents(minutesAhead = 8 * 24 * 60) {
  if (!googleAuthed) {
    await jwtClient.authorize();
    googleAuthed = true;
    console.log("✅ Google JWT authorized (service account identity established).");
  }
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + minutesAhead * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    timeZone: TIMEZONE,
  });

  return res.data.items || [];
}



// 1-week-before reminders
const remindedWeek = new Set();

// 1-day-before reminders
const remindedDay = new Set();

// -------------------
// 7. Send reminder to Slack
// -------------------

async function sendSlackReminder(event, whenLabel) {
  const start = event.start.dateTime || event.start.date;
  const startTime = new Date(start).toLocaleString();

  let text = `⏰ *Upcoming event in ${whenLabel}*\n`;
  text += `*${event.summary || "Untitled event"}*\n`;
  text += `📅 ${startTime}\n`;

  if (event.location) {
    text += `📍 ${event.location}\n`;
  }

  if (event.htmlLink) {
    text += `🔗 <${event.htmlLink}|Open in Google Calendar>`;
  }

  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text,
    mrkdwn: true,
  });

  console.log(`Sent ${whenLabel} reminder for event:`, event.id, event.summary);
}



async function checkCalendarAndNotify() {
  try {
    // Look ahead 8 days so we catch both 1-week and 1-day windows
    const events = await getUpcomingEvents(9 * 24 * 60);
    console.log(`Fetched ${events.length} events from Google Calendar.`);

  for (const e of events.slice(0, 10)) {
    const startStr = e.start?.dateTime || e.start?.date;
    console.log(
      "•",
      (e.summary || "(no title)"),
      "| start:",
      startStr,
      "| id:",
      e.id
    );
  }

    
    const now = new Date();
const todayYMD = ymdInTZ(now);
const tomorrowYMD = ymdInTZ(addDays(now, 1));
const weekYMD = ymdInTZ(addDays(now, 7));

console.log(`Today: ${todayYMD} | Tomorrow: ${tomorrowYMD} | +7 days: ${weekYMD}`);

for (const event of events) {
  if (!event.id || !event.start) continue;

  const startStr = event.start.dateTime || event.start.date;
  if (!startStr) continue;

  const eventStart = new Date(startStr);
  const eventYMD = ymdInTZ(eventStart);

  // 1-day reminders: events happening tomorrow
  if (eventYMD === tomorrowYMD && !remindedDay.has(event.id)) {
    await sendSlackReminder(event, "1 day");
    remindedDay.add(event.id);
  }

  // 1-week reminders: events happening 7 days from today
  if (eventYMD === weekYMD && !remindedWeek.has(event.id)) {
    await sendSlackReminder(event, "1 week");
    remindedWeek.add(event.id);
  }
}

  } catch (err) {
    console.error("Error checking calendar:", err.response?.data || err);
  }
}

//testing
checkCalendarAndNotify();
// Default: every 5 minutes (from .env or fallback)
cron.schedule(process.env.CHECK_INTERVAL_CRON || "*/5 * * * *", () => {
  console.log("Checking calendar for upcoming events...");
  checkCalendarAndNotify();
});

console.log("Slack–Google Calendar reminder bot is starting up...");
