export interface CardState { repetitions: number; intervalDays: number; easeFactor: number; lapses: number }
export interface ReviewResult extends CardState { dueDate: string; isLeech: boolean }
export function reviewCard(state: CardState, grade: number, today: string): ReviewResult {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) throw new RangeError("Grade must be an integer 0–5");
  const intervalDays = grade < 3 ? 1 : state.repetitions === 0 ? 1 : state.repetitions === 1 ? 6 : Math.round(state.intervalDays * state.easeFactor);
  const lapses = state.lapses + (grade < 3 ? 1 : 0);
  const easeFactor = Math.max(1.3, Math.round((state.easeFactor + 0.1 - (5-grade)*(0.08+(5-grade)*0.02))*100)/100);
  const date = new Date(today + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() + intervalDays);
  return { repetitions: grade < 3 ? 0 : state.repetitions + 1, intervalDays, easeFactor, lapses, dueDate: date.toISOString().slice(0,10), isLeech: lapses >= 8 };
}
