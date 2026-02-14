#!/usr/bin/env node
/**
 * Extract transcript from a YouTube video.
 * Emulates the Python youtube-transcript-api (Innertube + timed XML).
 *
 * Usage:
 *   node dist/get_transcript.js <video_id_or_url> [--timestamps]
 *   node dist/get_transcript.js <video_id_or_url> --timestamps --from TIME [--to TIME] [--exclude START-END ...]
 *   node dist/get_transcript.js <video_id_or_url> --timestamps --only TIME [TIME ...] [--exclude START-END ...]
 */

const WATCH_URL = "https://www.youtube.com/watch?v={video_id}";
const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?key={api_key}";
const INNERTUBE_CONTEXT = {
  context: {
    client: { clientName: "ANDROID", clientVersion: "20.10.38" },
  },
};

interface TranscriptSnippet {
  text: string;
  start: number;
  duration: number;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { runs?: { text?: string }[] };
}

interface InnertubePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

function extractVideoId(urlOrId: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = urlOrId.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`Could not extract video ID from: ${urlOrId}`);
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse MM:SS or HH:MM:SS to seconds. Two segments = minutes:seconds, three = hours:minutes:seconds. */
function parseTimeString(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) throw new Error(`Invalid time: "${s}" (expected MM:SS or HH:MM:SS)`);
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const sec = parseInt(parts[1], 10);
    if (Number.isNaN(m) || Number.isNaN(sec) || m < 0 || sec < 0 || sec > 59) {
      throw new Error(`Invalid time: "${s}" (expected MM:SS, seconds 0-59)`);
    }
    return m * 60 + sec;
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const sec = parseInt(parts[2], 10);
    if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) || h < 0 || m < 0 || m > 59 || sec < 0 || sec > 59) {
      throw new Error(`Invalid time: "${s}" (expected HH:MM:SS, minutes and seconds 0-59)`);
    }
    return h * 3600 + m * 60 + sec;
  }
  throw new Error(`Invalid time: "${s}" (expected MM:SS or HH:MM:SS)`);
}

/** Parse START-END exclude range to [startSec, endSec]. */
function parseRangeString(s: string): [number, number] {
  const idx = s.indexOf("-");
  if (idx <= 0 || idx === s.length - 1) {
    throw new Error(`Invalid exclude range: "${s}" (expected START-END, e.g. 1:25:21-1:27:01)`);
  }
  const start = parseTimeString(s.slice(0, idx));
  const end = parseTimeString(s.slice(idx + 1));
  if (start > end) {
    throw new Error(`Invalid exclude range: "${s}" (start must be <= end)`);
  }
  return [start, end];
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

async function fetchWatchPageHtml(videoId: string): Promise<string> {
  const url = WATCH_URL.replace("{video_id}", videoId);
  const res = await fetch(url, {
    headers: { "Accept-Language": "en-US" },
  });
  if (!res.ok) throw new Error(`Failed to load video page: ${res.status}`);
  return res.text();
}

function extractInnertubeApiKey(html: string, videoId: string): string {
  const match = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
  if (match) return match[1];
  if (html.includes('class="g-recaptcha"')) {
    throw new Error("Request blocked (IP/rate limit). Try again later.");
  }
  throw new Error(`Could not extract Innertube API key for video ${videoId}`);
}

async function fetchInnertubeData(videoId: string, apiKey: string): Promise<InnertubePlayerResponse> {
  const url = INNERTUBE_API_URL.replace("{api_key}", apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...INNERTUBE_CONTEXT, videoId }),
  });
  if (!res.ok) throw new Error(`Innertube API error: ${res.status}`);
  const data = (await res.json()) as InnertubePlayerResponse;
  return data;
}

function getCaptionTracks(data: InnertubePlayerResponse, videoId: string): CaptionTrack[] {
  const status = data.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = data.playabilityStatus?.reason ?? status;
    if (status === "LOGIN_REQUIRED" && reason.includes("bot")) {
      throw new Error("Request blocked. Try again later.");
    }
    if (reason.includes("inappropriate")) {
      throw new Error("Video is age-restricted or unavailable.");
    }
    if (reason.includes("unavailable")) {
      throw new Error("Video is unavailable.");
    }
    throw new Error(`Video unplayable: ${reason}`);
  }

  const captions = data.captions?.playerCaptionsTracklistRenderer;
  const tracks = captions?.captionTracks;
  if (!tracks?.length) {
    throw new Error("Transcripts are disabled for this video.");
  }
  return tracks;
}

function findBestTrack(tracks: CaptionTrack[], languages: string[] = ["en"]): CaptionTrack {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const generated = tracks.filter((t) => t.kind === "asr");
  for (const lang of languages) {
    const t = manual.find((t) => t.languageCode === lang) ?? generated.find((t) => t.languageCode === lang);
    if (t) return t;
  }
  return tracks[0];
}

function parseTranscriptXml(xml: string): TranscriptSnippet[] {
  const snippets: TranscriptSnippet[] = [];
  const re = /<text start="([^"]+)" dur="([^"]*)"[^>]*>([^<]*)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const duration = parseFloat(m[2] || "0");
    const rawText = m[3];
    const text = unescapeHtml(rawText).replace(/<[^>]*>/g, "").trim();
    if (text) snippets.push({ text, start, duration });
  }
  return snippets;
}

async function fetchTranscriptSnippets(videoId: string, languages?: string[]): Promise<TranscriptSnippet[]> {
  const html = await fetchWatchPageHtml(videoId);
  const apiKey = extractInnertubeApiKey(html, videoId);
  const data = await fetchInnertubeData(videoId, apiKey);
  const tracks = getCaptionTracks(data, videoId);
  const track = findBestTrack(tracks, languages);
  const baseUrl = track.baseUrl.replace("&fmt=srv3", "");
  const res = await fetch(baseUrl);
  if (!res.ok) throw new Error("Failed to fetch transcript data.");
  const xml = await res.text();
  return parseTranscriptXml(xml);
}

function formatTranscript(snippets: TranscriptSnippet[], withTimestamps: boolean): string {
  if (withTimestamps) {
    return snippets.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
  }
  return snippets.map((s) => s.text).join("\n");
}

const FLAGS = new Set(["--timestamps", "-t", "--from", "--to", "--only", "--exclude"]);

interface ParseResult {
  video: string | undefined;
  timestamps: boolean;
  from?: number;
  to?: number;
  only?: number[];
  exclude?: [number, number][];
}

function parseArgs(): ParseResult {
  const args = process.argv.slice(2);
  const result: ParseResult = { video: undefined, timestamps: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--timestamps" || arg === "-t") {
      result.timestamps = true;
      i += 1;
      continue;
    }
    if (arg === "--from") {
      if (i + 1 >= args.length) throw new Error("--from requires a time value (e.g. 00:01:00)");
      result.from = parseTimeString(args[i + 1]);
      i += 2;
      continue;
    }
    if (arg === "--to") {
      if (i + 1 >= args.length) throw new Error("--to requires a time value (e.g. 00:05:00)");
      result.to = parseTimeString(args[i + 1]);
      i += 2;
      continue;
    }
    if (arg === "--only") {
      result.only = [];
      i += 1;
      while (i < args.length && !FLAGS.has(args[i])) {
        result.only.push(parseTimeString(args[i]));
        i += 1;
      }
      continue;
    }
    if (arg === "--exclude") {
      result.exclude = [];
      i += 1;
      while (i < args.length && !FLAGS.has(args[i])) {
        result.exclude.push(parseRangeString(args[i]));
        i += 1;
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      result.video = arg;
      i += 1;
      continue;
    }
    i += 1;
  }
  return result;
}

function filterSnippets(snippets: TranscriptSnippet[], opts: ParseResult): TranscriptSnippet[] {
  let filtered: TranscriptSnippet[];
  const hasRange = opts.from !== undefined || opts.to !== undefined;
  const hasOnly = opts.only !== undefined && opts.only.length > 0;
  if (hasOnly) {
    const onlySet = new Set(opts.only);
    filtered = snippets.filter((s) => onlySet.has(Math.round(s.start)));
  } else if (hasRange) {
    const fromSec = opts.from ?? 0;
    const toSec = opts.to ?? Infinity;
    if (fromSec > toSec) throw new Error("--from must be <= --to");
    filtered = snippets.filter((s) => s.start >= fromSec && s.start <= toSec);
  } else {
    filtered = [...snippets];
  }
  if (opts.exclude && opts.exclude.length > 0) {
    filtered = filtered.filter((s) => {
      for (const [lo, hi] of opts.exclude!) {
        if (s.start >= lo && s.start <= hi) return false;
      }
      return true;
    });
  }
  return filtered;
}

async function main(): Promise<void> {
  let opts: ParseResult;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const { video, timestamps, from, to, only, exclude } = opts;
  const hasRangeOpt = from !== undefined || to !== undefined || (only !== undefined && only.length > 0) || (exclude !== undefined && exclude.length > 0);
  if (hasRangeOpt && !timestamps) {
    console.error("Error: Time range options (--from, --to, --only, --exclude) require --timestamps.");
    process.exit(1);
  }
  if ((from !== undefined || to !== undefined) && only !== undefined && only.length > 0) {
    console.error("Error: Cannot use --from/--to with --only.");
    process.exit(1);
  }
  if (!video) {
    console.error("Usage: node dist/get_transcript.js <video_id_or_url> [--timestamps] [--from TIME] [--to TIME] | [--only TIME ...] [--exclude START-END ...]");
    process.exit(1);
  }
  try {
    const videoId = extractVideoId(video);
    let snippets = await fetchTranscriptSnippets(videoId, ["en"]);
    if (hasRangeOpt) {
      snippets = filterSnippets(snippets, opts);
    }
    const transcript = formatTranscript(snippets, timestamps);
    console.log(transcript);
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
