import { applyShowcaseActions, projectTotal, tableTotal, tableValues } from "../../../frontend/src/demo/showcaseModel.ts";

let project = structuredClone(window.__spliceSmokeProject);
if (Math.abs(projectTotal(project) - window.__spliceSmokeDerived.total) > 0.000001) throw new Error("Project totals changed before the browser check");
const listeners = new Set();
window.__spliceShowcaseBridge = {
  revision: window.__spliceSmokeRevision,
  getProject: () => project,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  apply(actions) {
    project = applyShowcaseActions(project, actions);
    for (const listener of listeners) listener(project);
  },
  select() {},
  tableValues: id => tableValues(project, id),
  total: id => id ? tableTotal(project, id) : projectTotal(project),
  reportReady: () => { window.__splicePreviewReady = true; },
  reportError: message => { throw new Error(message); },
};
