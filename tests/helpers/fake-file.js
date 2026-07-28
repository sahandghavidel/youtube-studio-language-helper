export class FakeFile {
  constructor(name, contents, options = {}) {
    this.name = name;
    this.webkitRelativePath = options.webkitRelativePath || "";
    this.type = options.type || "";
    this.lastModified = options.lastModified || 1_700_000_000_000;
    this.bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : new Uint8Array(contents);
    this.size = this.bytes.byteLength;
  }

  async text() {
    return new TextDecoder().decode(this.bytes);
  }

  slice(start = 0, end = this.size) {
    const bytes = this.bytes.slice(start, end);
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }
}

export function pngBytes(width = 1280, height = 720) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export function wavBytes(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return bytes;
}

export function m4aBytes(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode("M4A "), 8);
  return bytes;
}

export function validSrt(text = "Translated line") {
  return `1\n00:00:00,000 --> 00:00:01,500\n${text}\n`;
}

export function languageFiles(language, metadata = {}) {
  const json = JSON.stringify({ language, title: "Translated title", description: "Translated description", ...metadata });
  return [
    new FakeFile(`${language} - metadata.json`, json, { type: "application/json" }),
    new FakeFile(`${language}.srt`, validSrt(), { type: "text/plain" }),
    new FakeFile(`${language} - audio.wav`, wavBytes(), { type: "audio/wav" }),
    new FakeFile(`${language} - Thumbnail.png`, pngBytes(), { type: "image/png" })
  ];
}
