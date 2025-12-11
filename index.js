// Load environment variables from .env
require("dotenv").config();

const express = require("express");
const { WebClient } = require("@slack/web-api");
const { google } = require("googleapis");
const cron = require("node-cron");
const path = require("path");

// -------------------
// 1. Tiny web server (for health checks / hosting later)
// -------------------

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Slack–Google Calendar reminder bot is running.");
});

app.listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});

// -------------------
// 2. Slack client
// -------------------

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

// -------------------
// 3. Google Calendar client (service account)
// -------------------

const keyPath = path.join(__dirname, "service-account-key.json");
const serviceAccount = require(keyPath);

const jwtClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ["https://www.googleapis.com/auth/calendar.readonly"]
);

const calendar = google.calendar({ version: "v3", auth: jwtClient });

// -------------------
// 4. Timing constants
// -------------------

// Minutes in a week and a day
const WEEK_MIN = 7 * 24 * 60; // 10080
const DAY_MIN = 24 * 60;      // 1440

// How big a "window" we allow around the exact reminder time (in minutes)
// With cron every 5 minutes, a 10-minute window is safe
const WINDOW_MIN = 10;

// -------------------
// 5. Helper: fetch events in the next X minutes
// -------------------

async function getUpcomingEvents(minutesAhead = 8 * 24 * 60) {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + minutesAhead * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });

  return res.data.items || [];
}

// -------------------
// 6. Track which events we've already reminded on
// -------------------

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

// -------------------
// 8. Main loop: check events and send reminders
// -------------------

async function checkCalendarAndNotify() {
  try {
    // Look ahead 8 days so we catch both 1-week and 1-day windows
    const events = await getUpcomingEvents(8 * 24 * 60);
    const now = new Date();

    if (!events.length) {
      console.log("No upcoming events found in the next 8 days.");
    }

    for (const event of events) {
      if (!event.id || !event.start) continue;

      const startStr = event.start.dateTime || event.start.date;
      const startTime = new Date(startStr);
      const minutesToEvent = (startTime.getTime() - now.getTime()) / (60 * 1000);

      // Skip past events
      if (minutesToEvent < 0) continue;

      // 1-week-before window
      if (
        minutesToEvent <= WEEK_MIN &&
        minutesToEvent > WEEK_MIN - WINDOW_MIN &&
        !remindedWeek.has(event.id)
      ) {
        await sendSlackReminder(event, "1 week");
        remindedWeek.add(event.id);
      }

      // 1-day-before window
      if (
        minutesToEvent <= DAY_MIN &&
        minutesToEvent > DAY_MIN - WINDOW_MIN &&
        !remindedDay.has(event.id)
      ) {
        await sendSlackReminder(event, "1 day");
        remindedDay.add(event.id);
      }
    }
  } catch (err) {
    console.error("Error checking calendar:", err.response?.data || err);
  }
}

// -------------------
// 9. Cron scheduler
// -------------------

// Default: every 5 minutes (from .env or fallback)
cron.schedule(process.env.CHECK_INTERVAL_CRON || "*/5 * * * *", () => {
  console.log("Checking calendar for upcoming events...");
  checkCalendarAndNotify();
});

console.log("Slack–Google Calendar reminder bot is starting up...");
