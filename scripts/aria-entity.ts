import iconSource from '../aria.svg' with { type: 'text' };
import { voiceLevel, followEnvelope, backgroundPulse, strokeBrightness } from './aria-activity.ts';

type Meter = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sink: GainNode;
  samples: Float32Array<ArrayBuffer>;
};
type Part = 'visitor' | 'voice' | 'background';
const entityColors = [
  '#34d399',
  '#60a5fa',
  '#f87171',
  '#a78bfa',
  '#fbbf24',
  '#2dd4bf',
  '#fb923c',
  '#c084fc',
  '#fb7185',
  '#22d3ee'
] as const;

export function createAriaEntity() {
  const marks = new Set<SVGSVGElement>();
  let context: AudioContext | undefined;
  let input: Meter | undefined, output: Meter | undefined;
  let muted = false,
    working = false,
    impulse = 0;
  let visitorEnvelope = 0,
    voiceEnvelope = 0,
    backgroundEnvelope = 0;
  let frame: number | undefined,
    previous = performance.now();
  function render(part: Part, level: number) {
    const value = String(strokeBrightness(level));
    for (const svg of marks) svg.style.setProperty(`--aria-${part}`, value);
  }
  function read(meter?: Meter) {
    if (!meter) return 0;
    meter.analyser.getFloatTimeDomainData(meter.samples);
    return voiceLevel(meter.samples);
  }
  function animate(timestamp: number) {
    frame = undefined;
    const elapsed = Math.min(100, Math.max(0, timestamp - previous));
    previous = timestamp;
    impulse *= Math.exp(-elapsed / 220);
    visitorEnvelope = followEnvelope(visitorEnvelope, muted ? 0 : read(input), elapsed);
    voiceEnvelope = followEnvelope(voiceEnvelope, read(output), elapsed);
    backgroundEnvelope = followEnvelope(
      backgroundEnvelope,
      Math.max(working ? 0.16 : 0, impulse),
      elapsed
    );
    render('visitor', visitorEnvelope);
    render('voice', voiceEnvelope);
    render('background', backgroundEnvelope);
    if (
      input ||
      output ||
      working ||
      Math.max(visitorEnvelope, voiceEnvelope, backgroundEnvelope, impulse) > 0.0001
    )
      frame = requestAnimationFrame(animate);
  }
  function schedule() {
    if (frame !== undefined) return;
    previous = performance.now();
    frame = requestAnimationFrame(animate);
  }
  function disconnect(meter?: Meter) {
    meter?.source.disconnect();
    meter?.analyser.disconnect();
    meter?.sink.disconnect();
  }
  function meter(stream: MediaStream): Meter | undefined {
    if (!context) return;
    const source = context.createMediaStreamSource(stream),
      analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0;
    const sink = context.createGain();
    sink.gain.value = 0;
    // A silent analysis branch leaves WebRTC capture and playback untouched.
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(context.destination);
    return { source, analyser, sink, samples: new Float32Array(analyser.fftSize) };
  }
  return {
    mark() {
      const parsed = new DOMParser().parseFromString(iconSource, 'image/svg+xml');
      const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
      svg.classList.add('cv-aria-entity');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      marks.add(svg);
      return svg;
    },
    prepareAudio() {
      if (context || !window.AudioContext) return;
      try {
        context = new AudioContext();
        void context.resume().catch(() => {});
      } catch {
        /* Metering is optional; voice remains available. */
      }
      muted = false;
    },
    input(stream: MediaStream) {
      disconnect(input);
      input = meter(stream);
      schedule();
    },
    output(stream: MediaStream) {
      disconnect(output);
      output = meter(stream);
      schedule();
    },
    mute(value: boolean) {
      muted = value;
    },
    working(value: boolean) {
      working = value;
      schedule();
    },
    pulse(magnitude = 1) {
      impulse = backgroundPulse(impulse, magnitude);
      schedule();
    },
    stop() {
      disconnect(input);
      disconnect(output);
      input = undefined;
      output = undefined;
      working = false;
      impulse = 0;
      void context?.close().catch(() => {});
      context = undefined;
      schedule();
    }
  };
}

// The stroke-only hover boundary, colours and release delay come from uic.nz.
// Keep hover separate from the native voice envelopes and the panel's entity.
export function bindAriaEntityHover(button: HTMLButtonElement, svg: SVGSVGElement) {
  let isHovering = false,
    focused = false;
  let hoverTimeout: ReturnType<typeof setTimeout> | undefined;
  function enter() {
    clearTimeout(hoverTimeout);
    if (isHovering) return;
    isHovering = true;
    button.style.setProperty(
      '--aria-hover-dot',
      entityColors[Math.floor(Math.random() * entityColors.length)]!
    );
    button.classList.add('active');
  }
  function leave() {
    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
      if (focused) return;
      isHovering = false;
      // Retain the colour while CSS fades its contribution out. Resetting it
      // here would flash the dot before the exit transition finishes.
      button.classList.remove('active');
    }, 50);
  }
  for (const path of svg.querySelectorAll('path, circle')) {
    path.addEventListener('mouseenter', enter);
    path.addEventListener('mouseleave', leave);
  }
  button.addEventListener('focus', () => {
    if (!button.matches(':focus-visible')) return;
    focused = true;
    enter();
  });
  button.addEventListener('blur', () => {
    focused = false;
    leave();
  });
}

export function cycleHeroDot(hero: HTMLElement) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = Math.floor(Math.random() * entityColors.length);
  hero.style.setProperty('--cv-period-color', entityColors[previous]!);
  function pause() {
    clearTimeout(timer);
    timer = undefined;
  }
  function next() {
    if (document.hidden || motion.matches) return;
    // Never repeat a colour immediately, including when resuming the page.
    const offset = 1 + Math.floor(Math.random() * (entityColors.length - 1));
    previous = (previous + offset) % entityColors.length;
    hero.style.setProperty('--cv-period-color', entityColors[previous]!);
    timer = setTimeout(next, 6500);
  }
  function resume() {
    pause();
    if (motion.matches) hero.style.removeProperty('--cv-period-color');
    else if (!document.hidden) timer = setTimeout(next, 1000);
  }
  document.addEventListener('visibilitychange', resume);
  motion.addEventListener('change', resume);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  resume();
}

export function fitHeroEntity(hero: HTMLElement, button: HTMLButtonElement, svg: SVGSVGElement) {
  const bounds = svg.getBBox();
  const side = bounds.height + 2;
  svg.setAttribute(
    'viewBox',
    `${bounds.x + bounds.width / 2 - side / 2} ${bounds.y - 1} ${side} ${side}`
  );
  svg.style.overflow = 'visible';
  const context = document.createElement('canvas').getContext('2d');
  const title = hero.querySelector<HTMLElement>('h1'),
    summary = hero.querySelector<HTMLElement>('.cv-role span');
  if (!context || !title || !summary) return;
  function ink(element: HTMLElement) {
    const style = getComputedStyle(element);
    context!.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect(),
      metrics = context!.measureText(element.textContent || '');
    return {
      top: rect.top + metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent,
      bottom: rect.bottom - metrics.fontBoundingBoxDescent + metrics.actualBoundingBoxDescent
    };
  }
  const fit = () => {
    const titleInk = ink(title);
    const mobile = window.matchMedia('(max-width: 600px)').matches;
    const bottom = mobile ? titleInk.bottom : ink(summary).bottom;
    const height = bottom - titleInk.top;
    const size = (mobile ? 80 : height) * 1.25;
    const next = `${size.toFixed(2)}px`,
      margin = `${(titleInk.top + (height - size) / 2 - hero.getBoundingClientRect().top).toFixed(2)}px`;
    if (button.style.width !== next) {
      button.style.width = next;
      button.style.height = next;
    }
    if (button.style.marginTop !== margin) button.style.marginTop = margin;
    // Both dimensions are SVG user units, so their ratio is the painted
    // stroke thickness in CSS pixels at this responsive entity size.
    const stroke = Number.parseFloat(getComputedStyle(svg).strokeWidth) || 2;
    const dot = `${((stroke * size) / side).toFixed(3)}px`;
    if (hero.style.getPropertyValue('--cv-entity-stroke-size') !== dot)
      hero.style.setProperty('--cv-entity-stroke-size', dot);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(hero);
  observer.observe(title);
  observer.observe(summary);
  void document.fonts.ready.then(fit);
  document.fonts.addEventListener('loadingdone', fit);
  fit();
}
