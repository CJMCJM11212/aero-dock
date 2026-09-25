import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import "./media-player.css";

export type MediaPlayerProps = {
  title: string;
  artist: string;
  artworkUrl?: string | null;
  playing: boolean;
  mediaAvailable: boolean;
  volume: number;
  speakerMuted: boolean;
  microphoneMuted: boolean;
  microphoneAvailable: boolean;
  onPrevious(): void;
  onTogglePlayback(): void;
  onNext(): void;
  onVolumeChange(level: number): void;
  onToggleSpeakerMute(): void;
  onToggleMicrophoneMute(): void;
  onMovePointerDown(e: ReactPointerEvent): void;
  onResizePointerDown(e: ReactPointerEvent): void;
};

const Icon = ({ children }: { children: ReactNode }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    {children}
  </svg>
);

const PreviousIcon = () => (
  <Icon><path d="M6.75 5.5v13M18 6.25l-8.5 5.1a.76.76 0 0 0 0 1.3l8.5 5.1a.76.76 0 0 0 1.14-.65V6.9a.76.76 0 0 0-1.14-.65Z" /></Icon>
);

const NextIcon = () => (
  <Icon><path d="M17.25 5.5v13M6 6.25l8.5 5.1a.76.76 0 0 1 0 1.3L6 17.75a.76.76 0 0 1-1.14-.65V6.9A.76.76 0 0 1 6 6.25Z" /></Icon>
);

const PlayIcon = () => (
  <Icon><path d="m8.25 5.9 9.3 5.4a.8.8 0 0 1 0 1.4l-9.3 5.4a.8.8 0 0 1-1.2-.7V6.6a.8.8 0 0 1 1.2-.7Z" /></Icon>
);

const PauseIcon = () => (
  <Icon><path d="M8 5.5v13M16 5.5v13" /></Icon>
);

const SpeakerIcon = ({ muted }: { muted: boolean }) => (
  <Icon>
    <path d="M4.5 10.1h3.4l4.35-3.55v10.9L7.9 13.9H4.5z" />
    {muted ? <><path d="m16 9.25 4.5 4.5M20.5 9.25 16 13.75" /></> : <path d="M16 9a4.25 4.25 0 0 1 0 6M18.75 6.25a8.1 8.1 0 0 1 0 11.5" />}
  </Icon>
);

const MicrophoneIcon = ({ muted }: { muted: boolean }) => (
  <Icon>
    <path d="M12 4.25a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4.25ZM6.7 11.5a5.3 5.3 0 0 0 10.6 0M12 16.8v3M8.75 19.8h6.5" />
    {muted && <path d="m5 5 14 14" />}
  </Icon>
);

const MoveIcon = () => (
  <Icon><path d="M12 3.5v17M3.5 12h17M8.7 7.3 12 3.5l3.3 3.8M8.7 16.7 12 20.5l3.3-3.8M7.3 8.7 3.5 12l3.8 3.3M16.7 8.7l3.8 3.3-3.8 3.3" /></Icon>
);

const ResizeIcon = () => (
  <Icon><path d="m9 18 9-9M13.5 18H18v-4.5" /></Icon>
);

export function MediaPlayer({
  title,
  artist,
  artworkUrl,
  playing,
  mediaAvailable,
  volume,
  speakerMuted,
  microphoneMuted,
  microphoneAvailable,
  onPrevious,
  onTogglePlayback,
  onNext,
  onVolumeChange,
  onToggleSpeakerMute,
  onToggleMicrophoneMute,
  onMovePointerDown,
  onResizePointerDown,
}: MediaPlayerProps) {
  const safeVolume = Math.min(100, Math.max(0, Math.round(volume)));
  const status = mediaAvailable
    ? playing ? "재생 중" : "일시 정지됨"
    : "재생 중인 미디어 없음";

  return (
    <section className="media-player" aria-label="미디어 재생">
      <button
        className="media-player__move-handle"
        type="button"
        aria-label="재생바 위치 이동"
        title="드래그해서 재생바 위치 이동"
        onPointerDown={onMovePointerDown}
      >
        <MoveIcon />
      </button>

      <div className="media-player__now-playing">
        <div className="media-player__artwork" aria-hidden="true">
          {artworkUrl ? <img src={artworkUrl} alt="" /> : <span />}
        </div>
        <div className="media-player__metadata">
          <p className="media-player__title" title={mediaAvailable ? title : undefined}>
            {mediaAvailable ? title : "재생 중인 미디어 없음"}
          </p>
          {mediaAvailable && artist ? <p className="media-player__artist" title={artist}>{artist}</p> : null}
          <span className="sr-only" aria-live="polite">{status}</span>
        </div>
      </div>

      <div className="media-player__transport" aria-label="재생 제어">
        <button type="button" aria-label="이전 곡" title="이전 곡" disabled={!mediaAvailable} onClick={onPrevious}>
          <PreviousIcon />
        </button>
        <button
          className="media-player__play-button"
          type="button"
          aria-label={playing ? "일시 정지" : "재생"}
          title={playing ? "일시 정지" : "재생"}
          aria-pressed={playing}
          disabled={!mediaAvailable}
          onClick={onTogglePlayback}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button type="button" aria-label="다음 곡" title="다음 곡" disabled={!mediaAvailable} onClick={onNext}>
          <NextIcon />
        </button>
      </div>

      <div className="media-player__audio-controls">
        <button
          className="media-player__speaker-button"
          type="button"
          aria-label={speakerMuted ? "스피커 음소거 해제" : "스피커 음소거"}
          title={speakerMuted ? "스피커 음소거 해제" : "스피커 음소거"}
          aria-pressed={speakerMuted}
          onClick={onToggleSpeakerMute}
        >
          <SpeakerIcon muted={speakerMuted} />
        </button>
        <label className="media-player__volume">
          <span className="sr-only">볼륨 {safeVolume}퍼센트</span>
          <input
            aria-label={`볼륨 ${safeVolume}퍼센트`}
            type="range"
            min="0"
            max="100"
            value={safeVolume}
            disabled={speakerMuted}
            style={{ "--media-volume": `${safeVolume}%` } as CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
          />
        </label>
        <button
          className="media-player__microphone-button"
          type="button"
          aria-label={microphoneMuted ? "마이크 차단 해제" : "마이크 차단"}
          title={microphoneMuted ? "마이크 차단 해제" : "마이크 차단"}
          aria-pressed={microphoneMuted}
          disabled={!microphoneAvailable}
          onClick={onToggleMicrophoneMute}
        >
          <MicrophoneIcon muted={microphoneMuted} />
        </button>
      </div>

      <button
        className="media-player__resize-handle"
        type="button"
        aria-label="재생바 크기 조절"
        title="드래그해서 재생바 크기 조절"
        onPointerDown={onResizePointerDown}
      >
        <ResizeIcon />
      </button>
    </section>
  );
}
