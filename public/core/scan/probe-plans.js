// @ts-check
/**
 * Probe frames and identity rules (WEB_PORT_PLAN.md section 6, from CSC port_scanner.py).
 * Every probe here is a READ. The scan test asserts that no emulator ever classifies a
 * scan write as anything but "read".
 */
import { ascii, text } from "../bytes.js";
import { asciiSum } from "../checks/sum8.js";
import { cdgRequest } from "../codecs/cdg-serial.js";
import { pxgFrame, CMD_READ } from "../codecs/inficon-binary.js";
import { PXG_BAUD_RATES, P3V02_BAUD, SCAN_BASE_BAUD } from "../constants.js";

// PPG ASCII (INFICON PPG550 / PPG570); broadcast address 254 works in RS232 mode.
export const PPG_FV = ascii("@254FV?\\");
export const PPG_SN = ascii("@254SN?\\");
export const PPG_PR1 = ascii("@254PR1?\\");
export const PPG_PR3 = ascii("@254PR3?\\");

/** @param {number} address @param {string} mnemonic */
export const ppgRead = (address, mnemonic) => ascii(`@${String(address).padStart(3, "0")}${mnemonic}?\\`);

/** True for "@ACK...\" and address-prefixed "@253ACK...\" (CSC `_ppg_is_ack`). @param {Uint8Array} raw */
export function ppgIsAck(raw) {
  const s = text(raw);
  return s.startsWith("@ACK") || (s.length >= 8 && s[0] === "@" && /^\d{3}$/.test(s.slice(1, 4)) && s.slice(4, 7) === "ACK");
}

/** @param {Uint8Array} raw */
export function ppgData(raw) {
  const s = text(raw);
  if (s.startsWith("@ACK")) return s.slice(4, -1).trim();
  if (ppgIsAck(raw)) return s.slice(7, -1).trim();
  return "";
}

/** Pfeiffer ASCII read request (CSC `_pfa_read_frame`). @param {number} param @param {number} [address] */
export function pfaRead(param, address = 1) {
  const body = `${String(address).padStart(3, "0")}00${String(param).padStart(3, "0")}02=?`;
  return ascii(`${body}${String(asciiSum(body)).padStart(3, "0")}\r`);
}
export const PFA_FW = pfaRead(309);
export const PFA_HW = pfaRead(310);

/**
 * A well-formed Pfeiffer ASCII RESPONSE (action 10 or 11), so an echoed request never
 * validates (CSC `_valid_pfeiffer_frame`).
 * @param {Uint8Array} raw
 */
export function pfaValidResponse(raw) {
  if (raw.length < 14) return false;
  const s = text(raw);
  if (!/^\d{3}$/.test(s.slice(0, 3))) return false;
  if (s.slice(3, 5) !== "10" && s.slice(3, 5) !== "11") return false;
  if (!/^\d{2}$/.test(s.slice(8, 10))) return false;
  const len = Number(s.slice(8, 10));
  if (s.length !== 14 + len || !s.endsWith("\r")) return false;
  return Number(s.slice(-4, -1)) === asciiSum(s.slice(0, -4));
}

/** @param {Uint8Array} raw */
export const pfaData = (raw) => {
  const s = text(raw);
  return s.slice(10, 10 + Number(s.slice(8, 10)));
};

/** Model hint from a Pfeiffer ASCII firmware string (CSC `_identify_pfeiffer`). @param {string} firmware */
export function pfaModelHint(firmware) {
  const fw = firmware.toUpperCase();
  if (fw.includes("TC600") || fw.includes("TC 600")) return "TC600";
  if (fw.includes("BCG550") || fw.includes("BCG552")) return "BCG552";
  if (fw.includes("BCG")) return "BCG450";
  if (/BPG|MPG|MAG|PCG|PSG|OPG/.test(fw)) return firmware.slice(0, 6).trim();
  return "";
}

export const CDG_PRESSURE_READ = cdgRequest(0x00, 0x00);
export const CDG_TYPE_READ = cdgRequest(0x00, 0x3b);

/** PxG55x read request. @param {number} pid @param {number} [address] */
export const pxgRead = (pid, address = 0) => pxgFrame({ address, cmd: CMD_READ, pid });
export const PXG_PID_PRODUCT = 208;
export const PXG_PID_PRESSURE = 221;
export const PXG_PID_SERIAL = 207;
export const PXG_PID_FIRMWARE = 218;

/**
 * The per-port probe plan (plan section 6, step 3). Quick uses only documented factory
 * rates; Thorough tries every rate.
 * @param {"quick" | "thorough"} mode
 */
export function probePlan(mode = "quick") {
  /** @type {{ step: string, baudRate: number, label: string }[]} */
  const plan = [
    { step: "listen", baudRate: SCAN_BASE_BAUD, label: "listening for a CDG left streaming" },
    { step: "ppg", baudRate: SCAN_BASE_BAUD, label: "trying INFICON PPG ASCII commands" },
    { step: "pfeiffer", baudRate: SCAN_BASE_BAUD, label: "trying Pfeiffer ASCII identification" },
    { step: "cdg", baudRate: SCAN_BASE_BAUD, label: "checking for CDG/HPG SKY binary frames" }
  ];
  if (mode === "thorough") plan.push({ step: "pxg", baudRate: SCAN_BASE_BAUD, label: "trying PxG55x binary at 9600 baud" });
  // 🟠 V2: 57600 is S16's factory rate, so it comes first and is the only PxG rate in Quick mode.
  for (const baud of PXG_BAUD_RATES.filter((b) => b !== SCAN_BASE_BAUD)) {
    if (mode === "quick" && baud !== 57600) continue;
    plan.push({ step: "pxg", baudRate: baud, label: `trying PxG55x binary at ${baud} baud` });
  }
  plan.push({ step: "p3v02", baudRate: P3V02_BAUD, label: "trying INFICON P3 V02 at 115200 baud for OPG550" });
  return plan;
}
