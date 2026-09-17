const REPORT_ID = 0x06;
const RPC_CHANNEL = 0x02;
const DEBUG_CHANNEL = 0x01;
const REPORT_LENGTH = 64;
const MAX_PAYLOAD = 61;
const BUTTON_KEYS = new Set(['ACT06', 'ACT07', 'ACT08', 'ACT09', 'ACT10', 'ACT12',
  'AG00', 'AG01', 'AG02', 'AG03', 'AG04', 'AG05']);
const ENCODER_KEYS = new Set(['ENC_CW', 'ENC_CC']);

function assertReport(report) {
  const value = Buffer.from(report || []);
  if (value.length !== REPORT_LENGTH || value[0] !== REPORT_ID ||
      ![RPC_CHANNEL, DEBUG_CHANNEL].includes(value[1]) || value[2] > MAX_PAYLOAD) {
    throw new Error('Invalid virtual Micro report.');
  }
  return value;
}

function encodeText(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (!bytes.length || bytes.length > 64 * 1024) throw new Error('Micro message is outside bounded size.');
  const reports = [];
  for (let offset = 0; offset < bytes.length;) {
    let length = Math.min(MAX_PAYLOAD, bytes.length - offset);
    while (offset + length < bytes.length && (bytes[offset + length] & 0xc0) === 0x80) length--;
    if (!length) throw new Error('Unable to split UTF-8 Micro payload.');
    const report = Buffer.alloc(REPORT_LENGTH);
    report[0] = REPORT_ID; report[1] = RPC_CHANNEL; report[2] = length;
    bytes.copy(report, 3, offset, offset + length);
    reports.push(report); offset += length;
  }
  return reports;
}

function encodeHid(key, action) {
  if (typeof key !== 'string' || (!BUTTON_KEYS.has(key) && !ENCODER_KEYS.has(key))) {
    throw new Error('Unsupported Micro control key.');
  }
  // Codex's button controls use ordinary press/release. The installed Micro
  // layout uses act:2 for an encoder detent, which has no held-key state.
  if ((BUTTON_KEYS.has(key) && ![0, 1].includes(action)) || (ENCODER_KEYS.has(key) && action !== 2)) {
    throw new Error('Unsupported Micro control action.');
  }
  return encodeText(`${JSON.stringify({ m: 'v.oai.hid', p: { k: key, act: action } })}\n`);
}

function decodeReports(reports) {
  return Buffer.concat(reports.map(assertReport).map(report => report.subarray(3, 3 + report[2]))).toString('utf8');
}

module.exports = {
  REPORT_ID, RPC_CHANNEL, DEBUG_CHANNEL, REPORT_LENGTH, MAX_PAYLOAD,
  BUTTON_KEYS, ENCODER_KEYS, assertReport, encodeText, encodeHid, decodeReports
};
