import { IdeWorkbench } from "./ide/IdeWorkbench";
import { demoMode } from "./demo/mode";
import { ShowcaseWorkspace } from "./demo/ShowcaseWorkspace";

export default function App() {
  return demoMode ? <ShowcaseWorkspace /> : <IdeWorkbench />;
}
