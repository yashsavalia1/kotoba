import path from 'node:path';
import { probe } from './media.mjs';
import { pathOf, langOfTag } from './library.mjs';
import { getSettings } from './settings.mjs';
import { capabilities } from './ffmpeg.mjs';

// Measured in Electron 45 / Chromium 156 with scripts/verify-playback.mjs --matrix over the
// scripts/make-fixtures.mjs set. Anything not listed streams through ffmpeg: avi, flv, ts,
// m2ts and asf do not open at all, and mp3-in-mp4 / vorbis-in-mkv played only some runs.
const DIRECT = {
  matroska: { video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'flac', 'mp3', 'pcm_s16le'] },
  webm: { video: ['vp9', 'av1'], audio: ['opus', 'vorbis'] },
  mp4: { video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'flac', 'pcm_s16le'] },
  ogg: { video: [], audio: ['vorbis'] },
};
// Chromium decodes these pixel formats; Hi10P h264 and 4:2:2/4:4:4 it does not.
const PIX = { h264: ['yuv420p', 'yuvj420p'], hevc: ['yuv420p', 'yuv420p10le'], vp9: ['yuv420p'], av1: ['yuv420p'] };
const decodable = (v) => PIX[v.codec_name]?.includes(v.pix_fmt) ?? false;
// Copied into the fragmented MP4 as-is (from COPY_FROM containers); any other audio becomes stereo AAC.
const COPY_AUDIO = ['aac', 'opus'];
// Copied video can only start on a keyframe and MPEG-TS seeks land late, so start well before the target.
const COPY_PREROLL = 12;
// Only these demuxers hand ffmpeg complete timestamps for copied video; avi/flv h264 has no pts.
const COPY_FROM = ['matroska', 'webm', 'mp4', 'mpegts'];
// Added to every output timestamp so B-frame dts before 0 stays positive; the client subtracts it.
export const TS_OFFSET = 10;

const videoStream = (info) => info.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
const audioStreams = (info) => info.streams?.filter((s) => s.codec_type === 'audio') ?? [];

function family(info, abs) {
  const f = info.format?.format_name ?? '';
  if (f.startsWith('matroska')) return path.extname(abs).toLowerCase() === '.webm' ? 'webm' : 'matroska';
  if (f.startsWith('mov,mp4')) return 'mp4';
  return f;
}

/** Why `audioIndex` cannot play directly in Chromium, or null when it can. */
export function streamReason(info, abs, audioIndex) {
  if (process.env.KOTOBA_PLAYBACK === 'stream') return 'KOTOBA_PLAYBACK=stream';
  const fam = family(info, abs);
  const t = DIRECT[fam];
  if (!t) return `${fam || 'unknown'} container`;
  const v = videoStream(info);
  if (v && !(t.video.includes(v.codec_name) && decodable(v))) return `${v.codec_name} ${v.pix_fmt} video`;
  const audios = audioStreams(info);
  const a = audios.find((s) => s.index === audioIndex);
  if (a && !t.audio.includes(a.codec_name)) return `${a.codec_name} audio`;
  // Chromium plays the first audio track whatever the default flag says, and switching
  // HTMLMediaElement.audioTracks was unreliable in the matrix.
  if (a && a !== audios[0]) return 'not the first audio track';
  return null;
}

/** The target-language track, else the default-flagged one, else the first. */
export function pickAudio(info, targetLang) {
  const audios = audioStreams(info);
  const lang = (s) => langOfTag(s.tags?.language ?? '') ?? langOfTag(s.tags?.title ?? '');
  return (audios.find((s) => lang(s) === targetLang) ?? audios.find((s) => s.disposition?.default === 1) ?? audios[0])?.index ?? null;
}

/**
 * How the renderer should play a media file. `direct` serves the original bytes through
 * kotoba://media/<id>; `stream` remuxes or transcodes through kotoba://stream/<id>.
 * Each audio entry says whether choosing it keeps direct mode.
 */
export async function playbackPlan(id) {
  const abs = pathOf(id);
  const info = await probe(abs);
  const video = videoStream(info);
  const audioStream = pickAudio(info, getSettings().targetLang);
  const reason = streamReason(info, abs, audioStream);
  return {
    mode: reason ? 'stream' : 'direct',
    reason,
    url: `kotoba://media/${id}`,
    streamUrl: `kotoba://stream/${id}`,
    duration: Number(info.format?.duration) || null,
    video: video ? { codec: video.codec_name, width: video.width, height: video.height, pixFmt: video.pix_fmt } : null,
    audioStream,
    audio: audioStreams(info).map((s, i) => {
      const why = streamReason(info, abs, s.index);
      return {
        index: s.index,
        order: i,
        codec: s.codec_name,
        channels: s.channels,
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
        default: s.disposition?.default === 1,
        directPlayable: why === null,
        reason: why,
      };
    }),
    chapters: (info.chapters ?? []).map((c) => ({
      start: Number(c.start_time),
      end: Number(c.end_time),
      title: c.tags?.title ?? '',
    })),
  };
}

/**
 * ffmpeg arguments for kotoba://stream: one video and one audio stream as fragmented MP4 on
 * stdout. Timestamps are media time + TS_OFFSET (copyts + frag_discont), so a restart just appends.
 */
export async function streamArgs(id, { start = 0, audio = null } = {}) {
  const abs = pathOf(id);
  const info = await probe(abs);
  const v = videoStream(info);
  const audios = audioStreams(info);
  const a = audios.find((s) => s.index === audio) ?? audios.find((s) => s.index === pickAudio(info, getSettings().targetLang));
  const fam = family(info, abs);
  const copyVideo = v && decodable(v) && COPY_FROM.includes(fam);
  const seek = copyVideo ? Math.max(0, start - COPY_PREROLL) : start;

  const out = [];
  if (v) {
    out.push('-map', `0:${v.index}`);
    if (copyVideo) out.push('-c:v', 'copy', ...(v.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : []));
    else if ((await capabilities()).encoders.has('h264_videotoolbox')) out.push('-c:v', 'h264_videotoolbox', '-b:v', '8M', '-pix_fmt', 'yuv420p');
    else out.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  if (a) {
    out.push('-map', `0:${a.index}`);
    // ADTS AAC (MPEG-TS) has no config yet when the moov is written up front, so it is re-encoded.
    if (COPY_AUDIO.includes(a.codec_name) && a.channels <= 2 && COPY_FROM.includes(fam) && fam !== 'mpegts') out.push('-c:a', 'copy');
    else out.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  return [
    '-hide_banner', '-v', 'error', '-nostdin',
    ...(seek > 0 ? ['-ss', String(seek)] : []), '-copyts', '-start_at_zero', '-i', abs,
    ...out,
    '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
    '-avoid_negative_ts', 'disabled', '-use_editlist', '0', '-output_ts_offset', String(TS_OFFSET),
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_discont', '-frag_duration', '500000',
    'pipe:1',
  ];
}
