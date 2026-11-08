/**
 * The provider side of image generation: the OpenAI-compatible
 * `POST /images/generations` request and its reply, with no Harness types.
 *
 * @module @kadaliao/dsh-images/lib/provider
 */

/** Sizes the tool suggests; a provider may take others, so they are not enforced. */
export const SIZES = ['1024x1024', '1536x1024', '1024x1536'];

/**
 * The images endpoint for a provider's base URL. A base that already names an
 * API version (`…/v1`) gets `/images/generations`; one that does not (an
 * Anthropic-style base) gets `/v1/images/generations`.
 * @param {string} baseURL
 * @returns {string}
 */
export function imagesEndpoint(baseURL) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (base === '') return '';
  return /\/v\d+[a-z]*$/i.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
}

/**
 * The request body. Empty fields are left out so a provider that does not take
 * them is not asked to.
 * @param {{model: string, prompt: string, size?: string, quality?: string, n?: number}} request
 * @returns {Record<string, unknown>}
 */
export function buildRequest(request) {
  const body = { model: request.model, prompt: request.prompt };
  const n = Number(request.n);
  if (Number.isInteger(n) && n > 1) body.n = Math.min(n, 4);
  const size = String(request.size ?? '').trim();
  if (size !== '' && size !== 'auto') body.size = size;
  const quality = String(request.quality ?? '').trim();
  if (quality !== '' && quality !== 'auto') body.quality = quality;
  return body;
}

/**
 * The images in a reply: inline bytes or a URL each, with the provider's
 * rewritten prompt when it gives one. Throws with the provider's own message
 * on an error body.
 * @param {unknown} json - the parsed reply.
 * @returns {{b64?: string, url?: string, revisedPrompt?: string}[]}
 */
export function parseReply(json) {
  if (!json || typeof json !== 'object') throw new Error('the provider returned no JSON');
  if (json.error) throw new Error(errorMessage(json));
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json.images) ? json.images : [];
  const out = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const b64 = typeof row.b64_json === 'string' ? row.b64_json : typeof row.b64 === 'string' ? row.b64 : '';
    const url = typeof row.url === 'string' ? row.url : '';
    if (b64 === '' && url === '') continue;
    const item = {};
    if (b64 !== '') item.b64 = b64;
    else item.url = url;
    if (typeof row.revised_prompt === 'string' && row.revised_prompt.trim() !== '') item.revisedPrompt = row.revised_prompt.trim();
    out.push(item);
  }
  if (out.length === 0) throw new Error('the provider returned no image');
  return out;
}

/**
 * The readable message of an error reply, whatever shape the provider uses.
 * @param {unknown} json
 * @returns {string}
 */
export function errorMessage(json) {
  if (!json || typeof json !== 'object') return typeof json === 'string' && json !== '' ? json.slice(0, 300) : 'request failed';
  const e = json.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    if (typeof e.message === 'string' && e.message !== '') return e.message;
    if (typeof e.msg === 'string') return e.msg;
  }
  if (typeof json.message === 'string' && json.message !== '') return json.message;
  if (typeof json.detail === 'string' && json.detail !== '') return json.detail;
  return 'request failed';
}

/**
 * The media type the first bytes declare, or undefined.
 * @param {Uint8Array} bytes
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|undefined}
 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/** The file extension of a media type. */
export function extensionOf(mediaType) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mediaType] ?? 'png';
}

/**
 * Pixel size read from the header of a PNG, JPEG, GIF or (lossy/lossless/extended)
 * WebP; `{width: 0, height: 0}` when it cannot be read.
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number}}
 */
export function dimensionsOf(bytes) {
  const none = { width: 0, height: 0 };
  if (!bytes || bytes.length < 24) return none;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = sniffMediaType(bytes);
  if (type === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (type === 'image/gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (type === 'image/webp') {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8 ' && bytes.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const b = view.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    return none;
  }
  if (type === 'image/jpeg') {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = view.getUint16(at + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      at += 2 + length;
    }
  }
  return none;
}
