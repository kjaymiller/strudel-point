import { useEffect, useRef } from "react";
import { getStrudelIfReady } from "../strudel";

/**
 * A live oscilloscope of everything currently playing — every sample and synth voice
 * from every pattern, not just whatever the local user last evaluated. Taps the shared
 * output bus (see getSuperdoughAudioController().output.destinationGain in strudel-web.d.ts)
 * with our own AnalyserNode, in parallel with its existing connection to the speakers —
 * a tap, not a rerouting, so it never affects what's actually heard.
 */
export function LiveWaveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let analyser: AnalyserNode | null = null;
    let buffer: Float32Array<ArrayBuffer> | null = null;
    let rafId: number;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const ctx = canvas.getContext("2d");

    function draw() {
      rafId = requestAnimationFrame(draw);
      const canvasEl = canvasRef.current;
      if (!ctx || !canvasEl) return;
      const { width, height } = canvasEl;
      ctx.clearRect(0, 0, width, height);

      if (!analyser || !buffer) return;
      analyser.getFloatTimeDomainData(buffer);

      ctx.strokeStyle = "#7ee0c1";
      ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
      ctx.beginPath();
      const mid = height / 2;
      for (let i = 0; i < buffer.length; i++) {
        const x = (i / (buffer.length - 1)) * width;
        const y = mid + buffer[i] * mid * 0.9;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Deliberately never calls getStrudel() itself — that does a real init (fetches the
    // sample pack, creates the AudioContext) and must only happen from a genuine user
    // gesture (an evaluate/hush click elsewhere). This just watches for that having
    // already happened, so the waveform shows a flat line until there's actually
    // something to show, rather than forcing init the moment the page loads.
    let cancelPoll = false;
    (function attachWhenReady() {
      if (cancelPoll) return;
      const strudel = getStrudelIfReady();
      const destinationGain = strudel?.getSuperdoughAudioController()?.output?.destinationGain;
      if (strudel && destinationGain) {
        analyser = strudel.getAudioContext().createAnalyser();
        analyser.fftSize = 2048;
        buffer = new Float32Array(analyser.fftSize);
        destinationGain.connect(analyser);
        return;
      }
      setTimeout(attachWhenReady, 500);
    })();

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelPoll = true;
      cancelAnimationFrame(rafId);
      observer.disconnect();
      analyser?.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="live-waveform-canvas" />;
}
