import {
  ariaEventSchema,
  statusSchema,
  sessionResultSchema,
  textEventSchema,
  errorResultSchema
} from '../shared/aria-contracts.ts';
import type { AriaEvent } from '../shared/aria-contracts.ts';
import {
  createAriaEntity,
  fitHeroEntity,
  bindAriaEntityHover,
  cycleHeroDot
} from './aria-entity.ts';
export type AriaIconName = 'x' | 'mic' | 'mic-off' | 'phone-off' | 'chevron-right';
interface Conversation {
  peer: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  channel: RTCDataChannel;
  muted: boolean;
  id?: string;
  events?: EventSource;
}
const preview = location.origin === 'https://aria.shaneholloman.dev';
const published = location.origin === 'https://shaneholloman.dev';
const service = preview
  ? '/aria-api'
  : published
    ? 'https://aria.shaneholloman.dev/aria-api'
    : 'http://127.0.0.1:8791';
const enabled = () =>
  preview || published || ['localhost', '127.0.0.1'].includes(location.hostname);

function mark() {
  const icon = document.createElement('span');
  icon.className = 'cv-aria-mark';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export function setupAria({ icon }: { icon: (name: AriaIconName) => SVGElement }): () => void {
  // The NAS preview adds this component to Mintlify's published bundle too.
  // Both entry points share one controller and one set of dialog listeners.
  const controller = Symbol.for('shane.cv.aria');
  const controllers = window as typeof window & { [key: symbol]: (() => void) | undefined };
  const existing = controllers[controller];
  if (existing) return existing;
  const entity = createAriaEntity();
  let heroButton: HTMLButtonElement | undefined;
  let heroFeedback: HTMLSpanElement | undefined;
  let activation: 'hero' | 'panel' = 'panel';
  let dialog: HTMLDialogElement,
    status: HTMLParagraphElement,
    start: HTMLButtonElement,
    mute: HTMLButtonElement;
  let voice: HTMLSelectElement,
    transcript: HTMLDivElement,
    input: HTMLInputElement,
    submit: HTMLButtonElement,
    close: HTMLButtonElement;
  let returnFocus: HTMLElement | undefined;
  let ready = false;
  let connecting = false;
  let conversation: Conversation | null = null;
  let generation = 0;
  let pending: AbortController | null = null;
  const captions: Record<'user' | 'assistant', { copy: HTMLParagraphElement; end: number } | null> =
    { user: null, assistant: null };
  const fitViewport = () => {
    if (!dialog?.open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    dialog.style.setProperty('--cv-aria-visible-height', `${viewport.height}px`);
    dialog.style.setProperty(
      '--cv-aria-bottom',
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`
    );
    dialog.toggleAttribute('data-compact', viewport.height < 440);
  };

  const button = (label: string, name: AriaIconName, action: () => void, className = '') => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.append(icon(name), document.createTextNode(label));
    element.addEventListener('click', action);
    return element;
  };
  const message = (role: 'user' | 'assistant', text: string) => {
    const item = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = role === 'user' ? 'You' : 'Aria';
    const copy = document.createElement('p');
    copy.textContent = text;
    item.append(label, copy);
    transcript.append(item);
    while (transcript.children.length > 30) transcript.firstChild?.remove();
    transcript.scrollTop = transcript.scrollHeight;
    return copy;
  };
  const controls = () => {
    if (heroButton) {
      const label = conversation
        ? 'End conversation'
        : connecting
          ? 'Cancel connection'
          : 'Speak with Aria';
      heroButton.setAttribute('aria-label', label);
      heroButton.setAttribute(
        'title',
        conversation || connecting ? `Aria Entity • ${label}` : 'Aria Entity'
      );
      heroButton.setAttribute('aria-pressed', String(Boolean(conversation || connecting)));
    }
    start.disabled = connecting || !ready || !navigator.mediaDevices?.getUserMedia;
    start.replaceChildren(
      icon(conversation ? 'phone-off' : 'mic'),
      document.createTextNode(
        conversation ? 'End conversation' : connecting ? 'Connecting…' : 'Ask Aria'
      )
    );
    mute.hidden = !conversation;
    voice.disabled = connecting || Boolean(conversation);
    mute.setAttribute('aria-pressed', String(Boolean(conversation?.muted)));
    const muteLabel = conversation?.muted ? 'Unmute microphone' : 'Mute microphone';
    mute.setAttribute('aria-label', muteLabel);
    mute.setAttribute('title', muteLabel);
    mute.replaceChildren(icon(conversation?.muted ? 'mic-off' : 'mic'));
  };
  async function request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${service}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    const result: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        errorResultSchema.safeParse(result).data?.error ||
          'Aria could not connect. Please try again.'
      );
    return result;
  }
  async function askInText(prompt: string, sessionId: string | undefined, signal: AbortSignal) {
    const response = await fetch(`${service}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, sessionId }),
      signal
    });
    if (!response.ok)
      throw new Error(
        errorResultSchema.safeParse(await response.json()).data?.error || 'Aria could not answer.'
      );
    if (!response.body) throw new Error('Aria did not return a response stream.');
    let buffer = '',
      answer: string | undefined;
    const decoder = new TextDecoder();
    for await (const bytes of response.body) {
      buffer = (buffer + decoder.decode(bytes, { stream: true })).replaceAll('\r\n', '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const packet = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = packet
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (!data) continue;
        const event = textEventSchema.parse(JSON.parse(data));
        if (event.type === 'aria.activity') entity.pulse(event.magnitude);
        if (event.type === 'aria.answer') answer = event.answer;
        if (event.type === 'aria.error') throw new Error(event.message);
      }
    }
    if (!answer) throw new Error('Aria did not finish its answer. Please try again.');
    return { answer };
  }
  function stop(text = 'Conversation ended.') {
    generation++;
    pending?.abort();
    pending = null;
    const current = conversation;
    conversation = null;
    connecting = false;
    entity.stop();
    if (current) {
      current.events?.close();
      current.channel?.close();
      current.peer.close();
      for (const track of current.stream.getTracks()) track.stop();
      current.audio.pause();
      current.audio.srcObject = null;
      current.audio.remove();
      if (current.id)
        void fetch(`${service}/session/${current.id}/end`, {
          method: 'POST',
          keepalive: true
        }).catch(() => {});
    }
    captions.user = null;
    captions.assistant = null;
    if (status) {
      status.textContent = text;
      if (heroFeedback) heroFeedback.textContent = text;
      controls();
      if (heroButton && activation === 'hero' && text !== 'Conversation ended.')
        heroButton.title = text;
    }
  }
  function receive(event: AriaEvent) {
    if (!conversation) return;
    if (event.type === 'aria.caption' && event.delta) {
      if (!dialog.open) return;
      const role = event.role;
      const current = captions[role];
      if (current && event.timestamp - current.end < 1600) {
        current.copy.textContent += event.delta;
        current.end = event.timestamp;
      } else captions[role] = { copy: message(role, event.delta), end: event.timestamp };
      transcript.scrollTop = transcript.scrollHeight;
      status.textContent = role === 'assistant' ? 'Aria is speaking…' : 'Listening…';
    }
    if (event.type === 'aria.thinking') {
      status.textContent = 'Looking that up…';
      entity.working(true);
    }
    if (event.type === 'aria.activity') entity.pulse(event.magnitude);
    if (event.type === 'aria.ready') entity.working(false);
    if (['aria.ready', 'output_audio_buffer.stopped'].includes(event.type))
      status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…';
    if (event.type === 'output_audio_buffer.started') status.textContent = 'Aria is speaking…';
    if (event.type === 'aria.turn.done')
      status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…';
    if (event.type === 'aria.error') stop(event.message);
    if (event.type === 'aria.closed' || event.type === 'session.closed')
      stop('Conversation ended. Start again whenever you like.');
  }
  async function connect() {
    if (conversation || connecting) {
      stop();
      return;
    }
    const currentGeneration = ++generation;
    pending = new AbortController();
    const signal = pending.signal;
    connecting = true;
    controls();
    status.textContent = 'Connecting…';
    if (heroFeedback) heroFeedback.textContent = 'Connecting to Aria.';
    let stream: MediaStream | undefined,
      peer: RTCPeerConnection | undefined,
      audio: HTMLAudioElement | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (currentGeneration !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      peer = new RTCPeerConnection();
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.hidden = true;
      audio.setAttribute('data-aria-audio', '');
      // Keep playback in the document even when the voice-only panel is closed.
      document.body.append(audio);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      entity.observe(peer);
      peer.addEventListener('track', (event) => {
        if (!audio) return;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void audio.play().catch(() => {
          if (currentGeneration === generation)
            status.textContent = 'Your browser blocked audio. End and restart the conversation.';
        });
      });
      const channel = peer.createDataChannel('oai-events');
      conversation = { peer, stream, audio, channel, muted: false };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete')
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            peer?.removeEventListener('icegatheringstatechange', change);
            signal.removeEventListener('abort', abort);
          };
          const change = () => {
            if (peer?.iceGatheringState === 'complete') {
              cleanup();
              resolve();
            }
          };
          const abort = () => {
            cleanup();
            reject(new DOMException('Cancelled', 'AbortError'));
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Voice network setup timed out. Please try again.'));
          }, 10_000);
          peer?.addEventListener('icegatheringstatechange', change);
          signal.addEventListener('abort', abort, { once: true });
          change();
        });
      const result = sessionResultSchema.parse(
        await request('/session', { sdp: peer.localDescription?.sdp, voice: 'cove' }, signal)
      );
      if (currentGeneration !== generation) {
        void request(`/session/${result.id}/end`, {}).catch(() => {});
        return;
      }
      conversation.id = result.id;
      conversation.events = new EventSource(`${service}/session/${result.id}/events`);
      conversation.events.onmessage = (event) => {
        if (currentGeneration !== generation) return;
        try {
          const parsed = ariaEventSchema.safeParse(JSON.parse(event.data));
          if (parsed.success) receive(parsed.data);
        } catch {
          /* Ignore malformed control events. */
        }
      };
      conversation.events.onerror = () => {
        if (currentGeneration === generation)
          stop('Connection lost. Please start another conversation.');
      };
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      await new Promise<void>((resolve, reject) => {
        if (channel.readyState === 'open') {
          resolve();
          return;
        }
        const timeout = setTimeout(
          () => reject(new Error('Voice connection timed out. Please try again.')),
          15_000
        );
        channel.addEventListener(
          'open',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true }
        );
      });
      if (currentGeneration !== generation) return;
      connecting = false;
      status.textContent = 'Listening…';
      if (heroFeedback)
        heroFeedback.textContent =
          'Aria is listening. Click the entity again to end the conversation.';
      controls();
      peer.addEventListener('connectionstatechange', () => {
        if (
          currentGeneration === generation &&
          peer &&
          ['failed', 'closed', 'disconnected'].includes(peer.connectionState)
        )
          stop('Voice disconnected. You can start again.');
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Voice connection failed.');
      if (currentGeneration !== generation) return;
      // Capture can succeed before a peer/session exists, so clean both paths.
      if (!conversation) {
        stream?.getTracks().forEach((track) => track.stop());
        peer?.close();
        if (audio) audio.srcObject = null;
      }
      stop(
        error.name === 'NotAllowedError'
          ? 'Microphone access was declined. You can still ask in text.'
          : error.name === 'NotFoundError'
            ? 'No microphone found. You can still ask in text.'
            : error.message === 'Failed to fetch'
              ? 'Aria is temporarily unavailable. Please try again.'
              : error.message
      );
    }
  }
  function createDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'cv-aria-dialog';
    dialog.setAttribute('aria-labelledby', 'cv-aria-title');
    dialog.setAttribute('aria-describedby', 'cv-aria-description');
    const header = document.createElement('div');
    header.className = 'cv-aria-header';
    const title = document.createElement('h2');
    title.id = 'cv-aria-title';
    const titleMark = entity.mark();
    titleMark.classList.add('cv-aria-title-mark');
    title.append(titleMark, document.createTextNode('Aria'));
    close = button('', 'x', () => dialog.close(), 'cv-aria-close');
    close.setAttribute('aria-label', 'Close Aria');
    header.append(title, close);
    const description = document.createElement('p');
    description.id = 'cv-aria-description';
    description.textContent = "Talk to Aria about Shane's work.";
    status = document.createElement('p');
    status.className = 'cv-aria-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'cv-aria-actions';
    start = button(
      'Ask Aria',
      'mic',
      () => {
        activation = 'panel';
        void connect();
      },
      'cv-aria-start'
    );
    mute = button(
      '',
      'mic',
      () => {
        if (!conversation) return;
        conversation.muted = !conversation.muted;
        for (const track of conversation.stream.getAudioTracks())
          track.enabled = !conversation.muted;
        entity.mute(conversation.muted);
        status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…';
        controls();
      },
      'cv-aria-mute'
    );
    mute.setAttribute('aria-label', 'Mute microphone');
    mute.setAttribute('title', 'Mute microphone');
    mute.hidden = true;
    actions.append(start, mute);
    const settings = document.createElement('label');
    settings.className = 'cv-aria-voice';
    settings.textContent = 'Voice';
    settings.hidden = true;
    voice = document.createElement('select');
    voice.setAttribute('aria-label', 'Voice');
    settings.append(voice);
    transcript = document.createElement('div');
    transcript.className = 'cv-aria-transcript';
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-label', 'Conversation transcript');
    transcript.setAttribute('aria-live', 'polite');
    transcript.setAttribute('aria-relevant', 'additions');
    transcript.tabIndex = 0;
    const form = document.createElement('form');
    form.className = 'cv-aria-form';
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Or ask in text';
    input.maxLength = 2000;
    input.setAttribute('aria-label', 'Ask Aria a question');
    input.autocomplete = 'off';
    submit = button('', 'chevron-right', () => {});
    submit.type = 'submit';
    submit.setAttribute('aria-label', 'Send question');
    form.append(input, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt || submit.disabled || !ready) return;
      submit.disabled = true;
      input.value = '';
      message('user', prompt);
      status.textContent = 'Thinking…';
      entity.working(true);
      const currentGeneration = generation;
      try {
        const result = await askInText(prompt, conversation?.id, AbortSignal.timeout(50_000));
        if (dialog.open && currentGeneration === generation) {
          if (!conversation) message('assistant', result.answer);
          status.textContent = conversation ? 'Listening…' : 'Ready to talk.';
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('Aria could not answer.');
        if (dialog.open && currentGeneration === generation)
          status.textContent =
            error.message === 'Failed to fetch'
              ? 'Aria is temporarily unavailable. Please try again.'
              : error.message;
      } finally {
        entity.working(false);
        submit.disabled = !ready;
      }
    });
    const note = document.createElement('p');
    note.className = 'cv-aria-note';
    note.textContent = 'Mic on only during conversations.';
    dialog.append(header, description, actions, settings, status, transcript, form, note);
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      if (activation === 'panel') stop();
      else {
        captions.user = null;
        captions.assistant = null;
        transcript.replaceChildren();
      }
      returnFocus?.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      )
        dialog.close();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const elements = [
        ...dialog.querySelectorAll<HTMLElement>('button, select, input, [tabindex="0"]')
      ].filter(
        (element) =>
          !('disabled' in element && element.disabled) &&
          !element.hidden &&
          element.getClientRects().length
      );
      const first = elements[0],
        last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }
  async function open(trigger: HTMLElement) {
    if (!dialog) createDialog();
    if (dialog.open) return;
    if (!conversation && !connecting) activation = 'panel';
    returnFocus = trigger;
    dialog.showModal();
    fitViewport();
    close.focus();
    const openGeneration = generation;
    ready = false;
    controls();
    submit.disabled = true;
    status.textContent = 'Connecting to Aria…';
    try {
      const response = await fetch(`${service}/status`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('Aria is temporarily unavailable. Please try again.');
      const info = statusSchema.parse(await response.json());
      if (!dialog.open || generation !== openGeneration) return;
      voice.replaceChildren(
        ...info.voices.map((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name[0].toUpperCase() + name.slice(1);
          return option;
        })
      );
      voice.value = 'cove';
      ready = info.authenticated;
      status.textContent = ready
        ? conversation
          ? 'Listening…'
          : 'Ready to talk.'
        : info.message || 'Aria needs to reconnect.';
      if (!navigator.mediaDevices?.getUserMedia) {
        status.textContent = 'Voice needs a browser with microphone support. You can ask in text.';
        start.disabled = true;
      }
    } catch {
      if (dialog.open && generation === openGeneration)
        status.textContent = 'Aria is temporarily unavailable. Please try again.';
    }
    if (dialog.open && generation === openGeneration) {
      controls();
      submit.disabled = !ready;
    }
  }
  document.addEventListener('click', (event) => {
    const hero = event.target instanceof Element ? event.target.closest('.cv-aria-hero') : null;
    if (hero) {
      event.preventDefault();
      if (!dialog) createDialog();
      activation = 'hero';
      void connect();
      return;
    }
    const trigger =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.cv-header-aria') : null;
    if (!trigger) return;
    event.preventDefault();
    const returnTarget = trigger.closest('nav[aria-label="Mobile menu"]')
      ? document.querySelector<HTMLElement>('#navbar button[aria-label="More actions"]') || trigger
      : trigger;
    void open(returnTarget);
  });
  window.addEventListener('pagehide', () => stop());
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  const updateHeader = function () {
    if (!enabled()) return;
    const hero = document.querySelector<HTMLElement>('.cv-hero');
    if (hero && !hero.querySelector('.cv-aria-hero')) {
      heroButton = document.createElement('button');
      heroButton.type = 'button';
      heroButton.className = 'cv-aria-hero';
      heroButton.setAttribute('aria-label', 'Speak with Aria');
      heroButton.setAttribute('title', 'Aria Entity');
      heroButton.setAttribute('aria-pressed', 'false');
      heroFeedback = document.createElement('span');
      heroFeedback.className = 'cv-aria-feedback';
      heroFeedback.id = 'cv-aria-feedback';
      heroFeedback.setAttribute('role', 'status');
      heroButton.setAttribute('aria-describedby', heroFeedback.id);
      const svg = entity.mark();
      heroButton.append(svg);
      hero.append(heroButton);
      hero.append(heroFeedback);
      fitHeroEntity(hero, heroButton, svg);
      bindAriaEntityHover(heroButton, svg);
      cycleHeroDot(hero);
    }
    for (const trigger of document.querySelectorAll('.navbar-link a[href$="#cv-aria"]')) {
      trigger.classList.add('cv-header-aria');
      trigger.setAttribute('aria-label', 'Talk to Aria');
      trigger.setAttribute('title', 'Talk to Aria');
      trigger.setAttribute('aria-haspopup', 'dialog');
    }
    const mobile = document.getElementById('search-bar-entry-mobile');
    if (mobile && !mobile.parentElement?.querySelector('.cv-header-aria')) {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'cv-header-aria';
      trigger.setAttribute('aria-label', 'Talk to Aria');
      trigger.setAttribute('title', 'Talk to Aria');
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.append(mark());
      mobile.after(trigger);
    }
  };
  controllers[controller] = updateHeader;
  return updateHeader;
}
