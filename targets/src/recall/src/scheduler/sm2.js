"use strict";
const MIN_EASE = 1.3;
const LEECH_THRESHOLD = 8;
function checkGrade(q) {
  if (!Number.isInteger(q) || q < 0 || q > 5) {
    throw new RangeError("grade must be an integer 0-5");
  }
}
function updateEase(ease, q) {
  const next = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Math.max(MIN_EASE, Math.round(next * 100) / 100);
}
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * card: { reps, interval, ease, lapses, due }  (due = epoch ms)
 * q: recall grade 0..5, now: epoch ms
 */
function scheduleReview(card, q, now) {
  checkGrade(q);
  const next = Object.assign({}, card);
  if (q >= 3) {
    next.interval = card.reps === 0 ? 1 : card.reps === 1 ? 6 : Math.round(card.interval * card.ease);
    next.reps = card.reps + 1;
  } else {
    next.reps = 0;
    next.interval = 1;
    next.lapses = (card.lapses || 0) + 1;
  }
  next.ease = updateEase(card.ease, q);
  next.due = now + next.interval * DAY_MS;
  next.leech = (next.lapses || 0) >= LEECH_THRESHOLD;
  return next;
}
module.exports = { scheduleReview, updateEase, DAY_MS };
