// A real oscilloscope, not a static waveform illustration — @strudel/web bundles
// @strudel/webaudio, whose scope.mjs patches `Pattern.prototype.scope()` to tap an
// AnalyserNode and self-animate onto a canvas found by DOM id (see getDrawContext in
// @strudel/draw). "test-canvas" is that function's own default id, not our naming
// choice — rendering our own canvas under that id here means the scope draws straight
// into this panel instead of falling back to a fullscreen overlay it'd otherwise create.
// See patch.ts/App.tsx for why `.scope(...)` is appended only to the local preview eval
// and never to the code that gets broadcast/saved (another client's canvas isn't ours to
// assume exists).
export function Scope() {
  return (
    <section className="panel scope-panel">
      <h3>Scope</h3>
      <canvas id="test-canvas" className="scope-canvas" width={960} height={160} />
    </section>
  );
}
