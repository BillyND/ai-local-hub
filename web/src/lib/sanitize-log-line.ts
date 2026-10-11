// CSI / OSC / other escape sequences, then remaining control chars (tab kept as spaces).
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

export function sanitizeLogLine(line: string): string {
  return line.replace(ESCAPES, '').replace(/\t/g, '  ').replace(CONTROL, '')
}
