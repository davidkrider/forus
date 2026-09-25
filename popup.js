// popup.js (module)
// Loads config into the form, saves back, and runs a one-shot smoke test.

import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./lib/config.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  enabled: $("#enabled"),
  backend: $("#backend"),
  apiKey: $("#apiKey"),
  layaEndpoint: $("#layaEndpoint"),
  layaModel: $("#layaModel"),
  minValueToKeep: $("#minValueToKeep"),
  valueVal: $("#valueVal"),
  minNoiseToHide: $("#minNoiseToHide"),
  noiseVal: $("#noiseVal"),
  showPanel: $("#showPanel"),
  useAccountSignals: $("#useAccountSignals"),
  useCommunityNotes: $("#useCommunityNotes"),
  lenientOnFollows: $("#lenientOnFollows"),
  save: $("#save"),
  test: $("#test"),
  status: $("#status")
};

let config = structuredClone(DEFAULT_CONFIG);

function applyBackendFields() {
  const p = els.backend.value;
  for (const node of document.querySelectorAll("[data-show]")) {
    const list = node.getAttribute("data-show").split(/\s+/);
    node.hidden = !list.includes(p);
  }
}

function render() {
  els.enabled.checked = config.enabled;
  els.backend.value = config.backend === "laya" ? "laya" : "jev";
  els.apiKey.value = config.apiKey ?? "";
  els.layaEndpoint.value = config.layaEndpoint ?? "";
  els.layaModel.value = config.layaModel ?? "";
  els.minValueToKeep.value = config.minValueToKeep;
  els.valueVal.textContent = String(config.minValueToKeep);
  els.minNoiseToHide.value = config.minNoiseToHide;
  els.noiseVal.textContent = String(config.minNoiseToHide);
  els.showPanel.checked = config.showPanel;
  els.useAccountSignals.checked = config.useAccountSignals !== false;
  els.useCommunityNotes.checked = config.useCommunityNotes !== false;
  els.lenientOnFollows.checked = config.lenientOnFollows !== false;
  applyBackendFields();
}

function collect() {
  config.enabled = els.enabled.checked;
  config.backend = els.backend.value === "laya" ? "laya" : "jev";
  config.apiKey = els.apiKey.value.trim();
  config.layaEndpoint = els.layaEndpoint.value.trim();
  config.layaModel = els.layaModel.value.trim();
  config.minValueToKeep = Number(els.minValueToKeep.value);
  config.minNoiseToHide = Number(els.minNoiseToHide.value);
  config.showPanel = els.showPanel.checked;
  config.useAccountSignals = els.useAccountSignals.checked;
  config.useCommunityNotes = els.useCommunityNotes.checked;
  config.lenientOnFollows = els.lenientOnFollows.checked;
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

els.backend.addEventListener("change", applyBackendFields);
els.minValueToKeep.addEventListener("input", () => {
  els.valueVal.textContent = String(els.minValueToKeep.value);
});
els.minNoiseToHide.addEventListener("input", () => {
  els.noiseVal.textContent = String(els.minNoiseToHide.value);
});

els.save.addEventListener("click", async () => {
  collect();
  await saveConfig(config);
  setStatus("Saved.", "ok");
});

els.test.addEventListener("click", async () => {
  collect();
  await saveConfig(config);
  setStatus("Testing…");
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
    const tag = v.reason || v.category || "?";
    setStatus(`OK — ${tag}.`, "ok");
  });
});

(async function init() {
  config = await loadConfig();
  render();
})();
