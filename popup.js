// popup.js (module)
// Loads config into the form, shows only the selected provider's fields, saves back,
// and can run a one-shot "test" against the chosen backend.

import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./lib/config.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  enabled: $("#enabled"),
  provider: $("#provider"),
  apiKey: $("#apiKey"),
  model: $("#model"),
  endpoint: $("#endpoint"),
  minConfidence: $("#minConfidence"),
  confVal: $("#confVal"),
  cats: Array.from(document.querySelectorAll(".cat")),
  save: $("#save"),
  test: $("#test"),
  status: $("#status")
};

let config = structuredClone(DEFAULT_CONFIG);

function applyProviderFields() {
  const p = els.provider.value;
  const s = config.providers[p];
  els.apiKey.value = s.apiKey ?? "";
  els.model.value = s.model ?? "";
  els.endpoint.value = s.endpoint ?? "";

  // Show/hide elements whose data-show list includes the current provider.
  for (const node of document.querySelectorAll("[data-show]")) {
    const list = node.getAttribute("data-show").split(/\s+/);
    node.hidden = !list.includes(p);
  }
}

function render() {
  els.enabled.checked = config.enabled;
  els.provider.value = config.provider;
  els.minConfidence.value = config.minConfidence;
  els.confVal.textContent = Number(config.minConfidence).toFixed(2);
  for (const c of els.cats) c.checked = config.hideCategories.includes(c.value);
  applyProviderFields();
}

function collect() {
  config.enabled = els.enabled.checked;
  config.provider = els.provider.value;
  config.minConfidence = Number(els.minConfidence.value);
  config.hideCategories = els.cats.filter((c) => c.checked).map((c) => c.value);

  const p = els.provider.value;
  config.providers[p] = {
    ...config.providers[p],
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    endpoint: els.endpoint.value.trim()
  };
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// Wiring
els.provider.addEventListener("change", () => {
  // Persist current edits into the in-memory config before swapping field views.
  collect();
  applyProviderFields();
});
els.minConfidence.addEventListener("input", () => {
  els.confVal.textContent = Number(els.minConfidence.value).toFixed(2);
});

els.save.addEventListener("click", async () => {
  collect();
  await saveConfig(config);
  setStatus("Saved.", "ok");
});

els.test.addEventListener("click", async () => {
  collect();
  await saveConfig(config); // test uses whatever the background reads from storage
  setStatus("Testing backend\u2026");
  chrome.runtime.sendMessage({ type: "test" }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, "err");
      return;
    }
    if (!resp?.ok) {
      setStatus(resp?.error || "Test failed.", "err");
      return;
    }
    const v = resp.verdict;
    setStatus(`OK \u2014 sample classified as "${v.category}" (${v.confidence.toFixed(2)}).`, "ok");
  });
});

(async function init() {
  config = await loadConfig();
  render();
})();
