#!/usr/bin/env node
/**
 * Extract transcript from a YouTube video.
 * Emulates the Python youtube-transcript-api (Innertube + timed XML).
 *
 * Usage:
 *   node dist/get_transcript.js <video_id_or_url> [--timestamps]
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

function parseArgs(): { video: string | undefined; timestamps: boolean } {
  const args = process.argv.slice(2);
  const timestamps = args.includes("--timestamps") || args.includes("-t");
  const video = args.find((a) => !a.startsWith("-"));
  return { video, timestamps };
}

async function main(): Promise<void> {
  const { video, timestamps } = parseArgs();
  if (!video) {
    console.error("Usage: node dist/get_transcript.js <video_id_or_url> [--timestamps]");
    process.exit(1);
  }
  try {
    const videoId = extractVideoId(video);
    const snippets = await fetchTranscriptSnippets(videoId, ["en"]);
    const transcript = formatTranscript(snippets, timestamps);
    console.log(transcript);
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
