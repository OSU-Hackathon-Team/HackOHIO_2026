import { DEMO_NOTES } from "./notes";
import { showcaseId, type ShowcaseProject } from "./showcaseModel";

const seedBody = (id: string) => DEMO_NOTES.find(note => note.id === id)?.body;
const calcFence = /```calc\n[\s\S]*?\n```/;

/** Upgrade untouched Event budget recipe notes to shared, editable Calc tables. */
export function withLiveBudgetTables(project: ShowcaseProject): ShowcaseProject {
  const budget = project.notes.find(note => note.id === "budget" && note.body === seedBody("budget"));
  const inventory = project.notes.find(note => note.id === "inventory" && note.body === seedBody("inventory"));
  const costs = project.tables.find(table => table.title === "Event costs");
  if (!inventory && !(budget && costs)) return project;

  const next = structuredClone(project);
  if (budget && costs) {
    next.notes.find(note => note.id === budget.id)!.body = budget.body.replace(calcFence, `![[table:${costs.id}]]`);
  }
  if (inventory) {
    let stock = next.tables.find(table => table.title === "Inventory stock");
    if (!stock) {
      stock = { id: showcaseId(), title: "Inventory stock", grid: [["Product", "Units", "Location"], ["Pear", 3, "Booth"], ["Apple", 2, "Van"], ["Peach", 5, "Booth"], ["Banners", 1, "Van"]] };
      next.tables.push(stock);
    }
    next.notes.find(note => note.id === inventory.id)!.body = inventory.body.replace(calcFence, `![[table:${stock.id}]]`);
  }
  return next;
}
