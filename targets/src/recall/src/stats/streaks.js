"use strict";
const DAY = 86400000;

function toDay(iso) {
  return Math.floor(Date.parse(iso + "T00:00:00Z") / DAY);
}

/**
 * reviewDates: array of "YYYY-MM-DD" (duplicates allowed, any order)
 * today: "YYYY-MM-DD"
 * A streak stays "current" if the last review was today or yesterday.
 */
function computeStreak(reviewDates, today) {
  const days = Array.from(new Set(reviewDates.map(toDay))).sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0, lastReview: null };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const t = toDay(today);
  const last = days[days.length - 1];
  let current = 0;
  if (t - last <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0 && days[i] === days[i - 1] + 1; i--) current++;
  }
  return { current, longest, lastReview: new Date(last * DAY).toISOString().slice(0, 10) };
}

module.exports = { computeStreak };
