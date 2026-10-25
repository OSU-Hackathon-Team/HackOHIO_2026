const cardEl = document.getElementById("card");
const gradesEl = document.getElementById("grades");
const streakEl = document.getElementById("streak");
const errorEl = document.getElementById("error");

async function render() {
  const deck = await window.recall.state();
  const card = deck.cards[0];
  cardEl.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = card.front;
  const answer = document.createElement("p");
  answer.textContent = card.back;
  const due = document.createElement("p");
  due.textContent = `Reviews: ${card.reps} · Interval: ${card.interval} day(s) · Due: ${card.due ? new Date(card.due).toLocaleDateString() : "now"}`;
  cardEl.append(heading, answer, due);
  const streak = await window.recall.streak();
  streakEl.textContent = `Current streak: ${streak.current} · Longest: ${streak.longest}`;
}

for (let grade = 0; grade <= 5; grade++) {
  const button = document.createElement("button");
  button.textContent = String(grade);
  button.setAttribute("aria-label", `Grade ${grade}`);
  button.addEventListener("click", async () => {
    try { errorEl.textContent = ""; await window.recall.answer("first", grade); await render(); }
    catch (error) { errorEl.textContent = error.message; }
  });
  gradesEl.appendChild(button);
}
window.recall.prepare().then(render).catch(error => { errorEl.textContent = error.message; });
