// iOS mute-switch bypass.
//
// By default Safari plays the Web Audio API through the "ambient" audio session,
// which the hardware ring/silent switch silences — so on a muted iPhone you hear
// nothing. Apps like Spotify use the "playback" category, which ignores the switch.
//
// Playing a looping (silent) HTMLAudioElement inside a user gesture flips Safari's
// session to "playback", so the Web Audio rendered afterwards reaches the speaker
// regardless of the ring switch. This is the well-known "unmute-ios" technique.
//
// Caveats: Apple changes this between iOS versions (no guarantee), and grabbing the
// playback session can pause the user's other audio. iOS only; a no-op elsewhere.

let element: HTMLAudioElement | null = null;
let silentUrl: string | null = null;
let rearmBound = false;

function isIos(): boolean {
  const ua = navigator.userAgent;
  const iosDevice = /iP(hone|od|ad)/.test(ua);
  // iPadOS 13+ masquerades as macOS; tell it apart by the touch points.
  const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iosDevice || iPadOs;
}

// Build a short, valid 16-bit PCM silent WAV at runtime so we never embed (and
// risk mistyping) a base64 blob. Digital silence at full volume stays inaudible.
function makeSilentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * 0.5);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // Sample bytes are already zero — i.e. silence.
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Flip iOS into the "playback" audio session so sound plays with the ring switch on.
 * Must be called inside a user-gesture handler (tap), before any await. Safe to call
 * repeatedly and a no-op on non-iOS browsers.
 */
export function primeIosAudioSession(): void {
  if (!isIos()) return;
  if (!element) {
    silentUrl = makeSilentWavUrl();
    element = document.createElement("audio");
    element.src = silentUrl;
    element.loop = true;
    element.preload = "auto";
    element.setAttribute("playsinline", "");
    element.style.display = "none";
    document.body.appendChild(element);
  }
  // play() inside the gesture is what performs the session-category switch.
  void element.play().catch(() => {
    // Rejected (e.g. iOS still refused) — the ring switch may keep applying.
  });
  if (!rearmBound) {
    rearmBound = true;
    // Returning from the background or a route change can drop the session; re-arm it.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && element) void element.play().catch(() => {});
    });
  }
}
