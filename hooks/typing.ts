const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

const KEY = /"code"\s*:\s*"/

const decodeFrom = (json: string, from: number): string => {
  let code = ''
  let at = from
  while (at < json.length && json[at] !== '"') {
    const char = json[at] as string
    const escaped = json[at + 1]
    if (char !== '\\') {
      code += char
      at += 1
    } else if (escaped === undefined) {
      return code
    } else if (escaped === 'u') {
      const hex = json.slice(at + 2, at + 6)
      if (hex.length < 4) return code
      code += String.fromCharCode(parseInt(hex, 16))
      at += 6
    } else {
      code += ESCAPES[escaped] ?? escaped
      at += 2
    }
  }
  return code
}

export function codeSoFar(json: string): string {
  const key = KEY.exec(json)
  return key === null ? '' : decodeFrom(json, key.index + key[0].length)
}
