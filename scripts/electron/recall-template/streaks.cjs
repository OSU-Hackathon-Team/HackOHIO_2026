const DAY = 86400000;

function dayNumber(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
}

function computeStreak(reviewDates, today) {
  const uniqueDays = [...new Set(reviewDates.map(dayNumber))].sort((a, b) => a - b);
  if (uniqueDays.length === 0) return { current: 0, longest: 0, lastReview: null };

  let longest = 0;
  let run = 0;
  for (let i = 0; i < uniqueDays.length; i++) {
    run = i > 0 && uniqueDays[i] === uniqueDays[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const last = uniqueDays.at(-1);
  let current = 0;
  if (dayNumber(today) - last <= 1) {
    current = 1;
    for (let i = uniqueDays.length - 1; i > 0 && uniqueDays[i] === uniqueDays[i - 1] + 1; i--) current++;
  }
  return { current, longest, lastReview: new Date(last * DAY).toISOString().slice(0, 10) };
}

module.exports = { computeStreak };
