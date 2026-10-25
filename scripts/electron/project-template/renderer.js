const $ = selector => document.querySelector(selector);
let manifest;

function currentFeature() { return manifest.features.find(feature => feature.id === $("#feature").value); }
function currentFunction() { return currentFeature().functions.find(entry => entry.name === $("#function").value); }

function showFunction() {
  const entry = currentFunction();
  $("#signature").textContent = `${entry.name}${entry.signature}`;
  $("#arguments").value = JSON.stringify(entry.example_args || [], null, 2);
  $("#result").textContent = entry.description || "Ready.";
}

function showFeature() {
  const feature = currentFeature();
  $("#description").textContent = feature.description;
  $("#function").replaceChildren(...feature.functions.map(entry => new Option(entry.name, entry.name)));
  showFunction();
}

$("#feature").addEventListener("change", showFeature);
$("#function").addEventListener("change", showFunction);
$("#run").addEventListener("click", async () => {
  try {
    const args = JSON.parse($("#arguments").value);
    if (!Array.isArray(args)) throw new TypeError("Enter a JSON array of arguments");
    const result = await window.workbench.invoke(currentFeature().id, currentFunction().name, args);
    $("#result").textContent = JSON.stringify(result, null, 2) ?? "undefined";
  } catch (error) { $("#result").textContent = `Error: ${error.message}`; }
});

window.workbench.manifest().then(value => {
  manifest = value;
  $("#title").textContent = `${manifest.source.package_name} feature workbench`;
  $("#coverage").textContent = `${manifest.features.length} verified feature(s). ${manifest.parity.unmatched_ipc_channels.length} original IPC channel(s), original storage, and original UI remain uncovered.`;
  $("#feature").replaceChildren(...manifest.features.map(feature => new Option(feature.title, feature.id)));
  showFeature();
}).catch(error => { $("#result").textContent = `Error loading workbench: ${error.message}`; });
