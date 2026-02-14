---
name: youtube-transcript
description: Extract transcripts from YouTube videos. Use when the user asks for a transcript, subtitles, or captions of a YouTube video and provides a YouTube URL (youtube.com/watch?v=, youtu.be/, or similar). Supports full transcript or a time range / specific clips (e.g. --from 00:01:00 --to 00:05:00 or --only 00:05:00 00:22:52). Supports output with or without timestamps.
---

# YouTube Transcript

Extract transcripts from YouTube videos using a TypeScript implementation that emulates the Python `youtube-transcript-api` (Innertube API + timed XML). No third-party transcript packages; Node.js 18+ and TypeScript only. Supports full transcript or a portion by time range or by specific start times.

**Requirements:** Node.js 18+ and npm.

## Before running

1. Run from the **project root** (the directory that contains `.cursor`). All paths below are relative to the project root.
2. Install and build once: `cd .cursor/skills/youtube-transcript && npm install && npm run build`. Omit the build step if already built.

## Usage

From the project root:

**Full transcript:**

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID"
```

**With timestamps:**

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID" --timestamps
```

**Portion by time range (--timestamps required):**

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID" --timestamps --from 00:01:00 --to 00:05:00
```

Includes snippets that start at 1:00 and at 5:00 (inclusive). Omit `--to` for "to end"; omit `--from` for "from start."

**Specific clips by start time (--only):**

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID" --timestamps --only 00:05:00 00:22:52
```

or a single clip:

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID" --timestamps --only 00:05:00
```

**Range with exclude (e.g. skip sponsor blocks):**

```bash
cd .cursor/skills/youtube-transcript && node dist/get_transcript.js "VIDEO_URL_OR_ID" --timestamps --from 52:12 --to 2:21:59 --exclude 1:25:21-1:27:01 1:51:29-1:53:03
```

## Time format

- **MM:SS** or **HH:MM:SS**. Two segments = minutes:seconds (e.g. `1:30` = 90 seconds). Three segments = hours:minutes:seconds (e.g. `1:30:00` = 5400 seconds).
- Exclude ranges: **START-END** (e.g. `1:25:21-1:27:01`). Space-separated for multiple.

## Behavior

- **Range (--from / --to):** Inclusive on both ends by snippet *start* time. Output may start or end mid-sentence at boundaries.
- **--only:** Includes every snippet whose start time (rounded to the nearest second) equals one of the given times.
- **--exclude:** Removes snippets whose start falls in any of the given ranges (inclusive). Applies in both range and --only mode.
- When using **--from**, **--to**, **--only**, or **--exclude**, **--timestamps** is required. Cannot use **--from/--to** together with **--only**.

## Defaults

- **Without timestamps** (default): Plain text, one line per caption segment
- **With timestamps**: `[MM:SS] text` format (or `[HH:MM:SS]` for longer videos)

## Supported URL formats

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`
- Raw video ID (11 characters)

## Output

- CRITICAL: YOU MUST NEVER MODIFY THE RETURNED TRANSCRIPT
- If the transcript is without timestamps, you SHOULD clean it up so that it is arranged by complete paragraphs and the lines don't cut in the middle of sentences.
- If you were asked to save the transcript to a specific file, save it to the requested file.
- If no output file was specified, use the YouTube video ID with a `-transcript.txt` suffix.

## Notes

- Fetches auto-generated or manually added captions (whichever is available); prefers manual, then English.
- Requires the video to have captions enabled.
- Uses YouTube's Innertube API (same approach as the Python youtube-transcript-api).
