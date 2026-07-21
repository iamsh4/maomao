"use strict";

const USB_VENDOR_ID = 0x352f;
const USB_PRODUCT_ID = 0x0411;
const CONTROL_REPORT_ID = 0xc4;
const CONTROL_REPORT_LENGTH = 63;

const REGISTERS = Object.freeze({
  microphoneGain: 0x207e,
  headphoneVolume: 0x207f,
  noiseCancellation: 0x2084,
  noiseLevel: 0x2085,
  rgbPower: 0x2089,
  rgbBrightness: 0x208a,
  rgbEffect: 0x208b,
  rgbColor: 0x208c,
  monitorOutput: 0x20af,
});

const DEFAULTS = Object.freeze({
  microphoneGain: 10,
  headphoneVolume: 10,
  noiseCancellation: true,
  noiseLevel: 1,
  rgbPower: true,
  rgbBrightness: 14,
  rgbEffect: "fixed",
  rgbColor: 5,
  monitorOutput: "both",
});

const MONITOR_VALUES = Object.freeze({ none: 4, mic: 5, computer: 6, both: 7 });
const EFFECT_VALUES = Object.freeze({ fixed: 0, loop: 1, breathing: 2 });
const COLORS = ["#f5f5ed", "#ff554f", "#ff8a45", "#ffd84f", "#59dc7d", "#52d9e9", "#5b7dff", "#e85ae8"];

let settings = loadSettings();
let device = null;
let connectionState = "disconnected";
let writeQueue = Promise.resolve();
const writeTimers = new Map();
const recentWrites = [];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const connectButton = $("#connect-button");
const connectLabel = $("#connect-label");
const connectionPill = $("#connection-pill");
const deviceName = $("#device-name");
const connectionMessage = $("#connection-message");
const connectionDetail = $("#connection-detail");
const browserWarning = $("#browser-warning");

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("maomao.settings.v1") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem("maomao.settings.v1", JSON.stringify(settings));
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  render();
}

function isPd200w(candidate) {
  return candidate.vendorId === USB_VENDOR_ID && candidate.productId === USB_PRODUCT_ID;
}

function buildRegisterWrite(address, value) {
  // The descriptor declares report ID 0xC4 followed by 63 data bytes.
  // WebHID takes that ID separately, unlike the HIDAPI framing we captured.
  const report = new Uint8Array(CONTROL_REPORT_LENGTH);
  report[0] = 0x0b;
  report[2] = 0x00;
  report[3] = 0x03;
  report[4] = address & 0xff;
  report[5] = (address >> 8) & 0xff;
  report[6] = value & 0xff;
  report[7] = (value >> 8) & 0xff;

  let sum = CONTROL_REPORT_ID;
  for (let index = 0; index < 8; index += 1) sum += report[index];
  const checksum = (-sum) & 0xffff;
  report[8] = checksum & 0xff;
  report[9] = (checksum >> 8) & 0xff;
  return report;
}

function setConnection(state, message, detail) {
  connectionState = state;
  connectionPill.className = `connection-pill ${state}`;
  deviceName.textContent = state === "connected" ? (device.productName || "Maono PD200W") : state === "connecting" ? "Connecting" : "Not connected";
  connectionMessage.textContent = message;
  connectionDetail.textContent = detail;
  connectLabel.textContent = state === "connected" ? "Disconnect" : state === "connecting" ? "Connecting…" : "Connect microphone";
  connectButton.disabled = state === "connecting" || state === "unsupported";
  $("#control-state").textContent = state === "connected" ? "LIVE" : "LOCAL";
  $("#footer-dot").classList.toggle("online", state === "connected");
}

async function openDevice(candidate) {
  setConnection("connecting", "Opening the control channel…", "Keep this page open while using the controls");
  try {
    if (!candidate.opened) await candidate.open();
    device = candidate;
    setConnection("connected", "Connected · changes apply instantly", "Firmware settings write directly over USB");
  } catch (error) {
    console.error(error);
    device = null;
    setConnection("error", "Couldn’t open the mic · close Maono Link and retry", "Only one app can use the control interface at a time");
  }
}

async function requestConnection() {
  if (connectionState === "connected") {
    const current = device;
    device = null;
    if (current?.opened) await current.close();
    setConnection("disconnected", "Disconnected safely", "Chrome or Edge · HTTPS required");
    return;
  }

  try {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID, usagePage: 0x000c, usage: 0x0001 }],
    });
    if (devices[0]) await openDevice(devices[0]);
  } catch (error) {
    console.error(error);
    setConnection("disconnected", "Connection cancelled", "Choose the PD200W when you’re ready");
  }
}

async function writeRegister(key, value, label) {
  if (!device?.opened) return;
  const report = buildRegisterWrite(REGISTERS[key], value);

  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await device.sendReport(CONTROL_REPORT_ID, report);
      recentWrites.unshift(label);
      const unique = [...new Set(recentWrites)].slice(0, 3);
      recentWrites.splice(0, recentWrites.length, ...unique);
      $("#recent-status").textContent = `Recent: ${recentWrites.join(" · ")}`;
      connectionMessage.textContent = `Applied · ${label}`;
    })
    .catch((error) => {
      console.error(error);
      const errorName = error?.name || "USB error";
      const errorDetail = error?.message || "The control interface rejected the report";
      setConnection("error", `Write failed · ${errorName}`, errorDetail);
    });

  await writeQueue;
}

function scheduleWrite(key, value, label) {
  clearTimeout(writeTimers.get(key));
  writeTimers.set(key, setTimeout(() => writeRegister(key, value, label), 70));
}

function renderRange(key) {
  const value = settings[key];
  const slider = $(`[data-slider="${key}"]`);
  const input = $(`[data-range="${key}"]`);
  slider.style.setProperty("--fill", `${(value / 20) * 100}%`);
  slider.querySelector("[data-value]").textContent = value;
  input.value = value;
  $(`[data-percent="${key}"]`).textContent = `${Math.round((value / 20) * 100)}%`;
}

function render() {
  renderRange("microphoneGain");
  renderRange("headphoneVolume");
  renderRange("rgbBrightness");

  const noiseToggle = $("#noise-toggle");
  noiseToggle.classList.toggle("is-on", settings.noiseCancellation);
  noiseToggle.setAttribute("aria-checked", String(settings.noiseCancellation));
  $$("[data-noise-level]").forEach((button) => {
    const selected = Number(button.dataset.noiseLevel) === settings.noiseLevel;
    button.classList.toggle("selected", selected);
    button.disabled = !settings.noiseCancellation;
  });

  $$("[data-monitor]").forEach((button) => {
    const selected = button.dataset.monitor === settings.monitorOutput;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });

  const rgbToggle = $("#rgb-toggle");
  rgbToggle.classList.toggle("is-on", settings.rgbPower);
  rgbToggle.setAttribute("aria-checked", String(settings.rgbPower));
  $("#lighting-content").classList.toggle("disabled", !settings.rgbPower);

  const selectedColor = COLORS[settings.rgbColor];
  $("#lighting-panel").style.setProperty("--rgb-color", selectedColor);
  $$("[data-color]").forEach((button) => {
    const selected = Number(button.dataset.color) === settings.rgbColor;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-checked", String(selected));
    button.disabled = !settings.rgbPower || settings.rgbEffect !== "fixed";
  });

  $("#effect").value = settings.rgbEffect;
  $("#effect").disabled = !settings.rgbPower;
  $("[data-range=rgbBrightness]").disabled = !settings.rgbPower;
}

function bindControls() {
  connectButton.addEventListener("click", requestConnection);

  $$("[data-range]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.range;
      const value = Number(input.value);
      setSetting(key, value);
      const labels = { microphoneGain: "Mic gain", headphoneVolume: "Headphones", rgbBrightness: "Brightness" };
      scheduleWrite(key, value, `${labels[key]} ${value}`);
    });
  });

  $("#noise-toggle").addEventListener("click", () => {
    const value = !settings.noiseCancellation;
    setSetting("noiseCancellation", value);
    writeRegister("noiseCancellation", value ? 1 : 0, `Noise cancellation ${value ? "on" : "off"}`);
  });

  $$("[data-noise-level]").forEach((button) => button.addEventListener("click", () => {
    const value = Number(button.dataset.noiseLevel);
    const names = ["Slight", "Moderate", "Aggressive"];
    setSetting("noiseLevel", value);
    writeRegister("noiseLevel", value, `${names[value]} noise reduction`);
  }));

  $$("[data-monitor]").forEach((button) => button.addEventListener("click", () => {
    const value = button.dataset.monitor;
    setSetting("monitorOutput", value);
    writeRegister("monitorOutput", MONITOR_VALUES[value], `Monitor ${value}`);
  }));

  $("#rgb-toggle").addEventListener("click", () => {
    const value = !settings.rgbPower;
    setSetting("rgbPower", value);
    writeRegister("rgbPower", value ? 1 : 0, `RGB ${value ? "on" : "off"}`);
  });

  $$("[data-color]").forEach((button) => button.addEventListener("click", () => {
    const value = Number(button.dataset.color);
    setSetting("rgbColor", value);
    writeRegister("rgbColor", value, `${button.dataset.name} light`);
  }));

  $("#effect").addEventListener("change", (event) => {
    const value = event.target.value;
    setSetting("rgbEffect", value);
    writeRegister("rgbEffect", EFFECT_VALUES[value], `${value} light effect`);
  });
}

async function initializeHid() {
  if (!("hid" in navigator)) {
    browserWarning.textContent = "This browser does not provide WebHID. Open Maomao in a Chromium-based Browser such as Chrome or Edge to connect the microphone.";
    browserWarning.classList.add("visible");
    setConnection("unsupported", "WebHID isn’t available in this browser", "Use desktop Chrome or Edge");
    return;
  }

  if (!window.isSecureContext) {
    browserWarning.textContent = "USB access is blocked because this page is not secure. Host it over HTTPS or open it from localhost.";
    browserWarning.classList.add("visible");
    setConnection("unsupported", "A secure connection is required", "Use HTTPS or localhost");
    return;
  }

  navigator.hid.addEventListener("connect", (event) => {
    if (isPd200w(event.device)) openDevice(event.device);
  });
  navigator.hid.addEventListener("disconnect", (event) => {
    if (event.device === device || isPd200w(event.device)) {
      device = null;
      setConnection("disconnected", "Microphone disconnected", "Reconnect it, then press Connect microphone");
    }
  });

  const knownDevices = await navigator.hid.getDevices();
  const known = knownDevices.find(isPd200w);
  if (known) await openDevice(known);
}

bindControls();
render();
initializeHid().catch((error) => console.error(error));
