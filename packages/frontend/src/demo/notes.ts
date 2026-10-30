// Seed notes for demo mode: a booth budget plan using every rendered Markdown feature and two Calc tables.
import type { NoteItem } from "../ide/store/useIdeStore";

const fence = "```";

export const DEMO_NOTES: NoteItem[] = [
  {
    id: "project-plan",
    title: "Project Plan",
    body: `# Project Plan

Launch plan for the **Splice** demo booth. Costs live in [[Budget]] and supplies in [[Inventory]].

> [!NOTE] Goal
> Show a notes app rebuilt from *Obsidian* and *LibreOffice Calc*.

## Milestones

- Prep
  - Print posters
  - Charge laptops
- Demo day
  - ~~Rehearse once~~ Rehearse twice

## Links

- Vendor list: [[Vendors]]
- Event site: [HackOHIO](https://hack.osu.edu)

${fence}js
console.log("ship it");
${fence}`,
  },
  {
    id: "budget",
    title: "Budget",
    body: `# Budget

Booth costs. Totals are live **Calc** formulas.

${fence}calc
Item | Qty | Unit cost | Total
Posters | 4 | 25 | =B2*C2
Stickers | 200 | 0.5 | =B3*C3
Snacks | 30 | 3 | =B4*C4
Grand total | | | =D2+D3+D4
${fence}

Back to [[Project Plan]].`,
  },
  {
    id: "inventory",
    title: "Inventory",
    body: `# Inventory

What we are bringing. Sort it from the table toolbar.

${fence}calc
Product | Units | Location
Pear | 3 | Booth
Apple | 2 | Van
Peach | 5 | Booth
Banners | 1 | Van
${fence}`,
  },
  {
    id: "vendors",
    title: "Vendors",
    body: `# Vendors

| Vendor | Item | Status |
|---|---|---|
| PrintCo | Posters | Ordered |
| StickerMule | Stickers | Shipped |

### Notes
Ask PrintCo about **rush** delivery. See [[Budget]].`,
  },
];
