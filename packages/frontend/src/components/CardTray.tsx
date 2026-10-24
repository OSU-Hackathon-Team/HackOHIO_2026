// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §5
import { useState } from "react";
import { useStudio } from "../store/useStudio";
import { FeatureCard } from "./FeatureCard";
import { EvidenceDrawer } from "./EvidenceDrawer";
export function CardTray() {
  const cards = useStudio(s => s.cards); const [open, setOpen] = useState<string>();
  return <section aria-labelledby="cards-heading">
    <div className="section-heading"><span className="step green">02</span><h2 id="cards-heading">Your feature collection</h2></div>
    {!Object.keys(cards).length && <div className="empty-state">Harvested features appear here, with their requirements and check results.</div>}
    <div className="card-grid">{Object.values(cards).map(card => <FeatureCard key={card.feature_id} card={card} onOpen={() => setOpen(card.feature_id)} />)}</div>
    {open && cards[open]?.spec && <EvidenceDrawer card={cards[open]} onClose={() => setOpen(undefined)} />}
  </section>;
}
