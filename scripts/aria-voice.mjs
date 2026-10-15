const preview = location.origin === 'https://aria.shaneholloman.dev';
const published = location.origin === 'https://shaneholloman.dev';
const service = preview ? '/aria-api' : published ? 'https://aria.shaneholloman.dev/aria-api' : 'http://127.0.0.1:8791';
const enabled = () => preview || published || ['localhost', '127.0.0.1'].includes(location.hostname);

function mark() {
  const icon = document.createElement('span');
  icon.className = 'cv-aria-mark';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export function setupAria({ icon }) {
  // The NAS preview adds this component to Mintlify's published bundle too.
  // Both entry points share one controller and one set of dialog listeners.
  const controller = Symbol.for('shane.cv.aria');
  if (window[controller]) return window[controller];
  let dialog, status, start, mute, voice, transcript, input, submit, close, returnFocus;
  let ready = false;
  let connecting = false;
  let conversation;
  let generation = 0;
  let pending;
  const captions = { user: null, assistant: null };

  const button = (label, name, action, className = '') => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className;
    element.append(icon(name), document.createTextNode(label));
    element.addEventListener('click', action);
    return element;
  };
  const message = (role, text) => {
    const item = document.createElement('div');
    const label = document.createElement('strong'); label.textContent = role === 'user' ? 'You' : 'Aria';
    const copy = document.createElement('p'); copy.textContent = text;
    item.append(label, copy); transcript.append(item);
    while (transcript.children.length > 30) transcript.firstChild.remove();
    transcript.scrollTop = transcript.scrollHeight;
    return copy;
  };
  const controls = () => {
    start.disabled = connecting || !ready || !navigator.mediaDevices?.getUserMedia;
    start.replaceChildren(icon(conversation ? 'phone-off' : 'mic'), document.createTextNode(conversation ? 'End conversation' : connecting ? 'Connecting…' : 'Start conversation'));
    mute.hidden = !conversation;
    voice.disabled = connecting || Boolean(conversation);
    mute.setAttribute('aria-pressed', String(Boolean(conversation?.muted)));
    mute.replaceChildren(icon(conversation?.muted ? 'mic-off' : 'mic'), document.createTextNode(conversation?.muted ? 'Unmute' : 'Mute'));
  };
  async function request(path, body, signal) {
    const response = await fetch(`${service}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Aria could not connect. Please try again.');
    return result;
  }
  function stop(text = 'Conversation ended.') {
    generation++;
    pending?.abort(); pending = null;
    const current = conversation; conversation = null; connecting = false;
    if (current) {
      current.events?.close();
      current.channel?.close(); current.peer.close();
      for (const track of current.stream.getTracks()) track.stop();
      current.audio.pause(); current.audio.srcObject = null;
      current.audio.remove();
      if (current.id) void fetch(`${service}/session/${current.id}/end`, { method: 'POST', keepalive: true }).catch(() => {});
    }
    captions.user = null; captions.assistant = null;
    if (status) { status.textContent = text; controls(); }
  }
  function receive(event) {
    if (!conversation) return;
    if (event.type === 'aria.caption' && event.delta) {
      const role = event.role;
      const current = captions[role];
      if (current && event.timestamp - current.end < 1600) {
        current.copy.textContent += event.delta; current.end = event.timestamp;
      } else captions[role] = { copy: message(role, event.delta), end: event.timestamp };
      transcript.scrollTop = transcript.scrollHeight;
      status.textContent = role === 'assistant' ? 'Aria is speaking…' : 'Listening…';
    }
    if (event.type === 'aria.thinking') status.textContent = 'Looking that up…';
    if (['aria.ready', 'output_audio_buffer.stopped'].includes(event.type)) status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…';
    if (event.type === 'output_audio_buffer.started') status.textContent = 'Aria is speaking…';
    if (event.type === 'aria.turn.done') status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…';
    if (event.type === 'aria.error') stop(event.message);
    if (event.type === 'aria.closed' || event.type === 'session.closed') stop('Conversation ended. Start again whenever you like.');
  }
  async function connect() {
    if (conversation || connecting) { stop(); return; }
    const currentGeneration = ++generation;
    pending = new AbortController(); const signal = pending.signal;
    connecting = true; controls(); status.textContent = 'Connecting…';
    let stream, peer, audio;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (currentGeneration !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
      peer = new RTCPeerConnection();
      audio = document.createElement('audio'); audio.autoplay = true; audio.hidden = true;
      audio.setAttribute('data-aria-audio', ''); dialog.append(audio);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.addEventListener('track', event => {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void audio.play().catch(() => { if (currentGeneration === generation) status.textContent = 'Your browser blocked audio. End and restart the conversation.'; });
      });
      const channel = peer.createDataChannel('oai-events');
      conversation = { peer, stream, audio, channel, muted: false };
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', change); signal.removeEventListener('abort', abort); };
        const change = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
        const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Voice network setup timed out. Please try again.')); }, 10_000);
        peer.addEventListener('icegatheringstatechange', change); signal.addEventListener('abort', abort, { once: true }); change();
      });
      const result = await request('/session', { sdp: peer.localDescription.sdp, voice: 'cove' }, signal);
      if (currentGeneration !== generation) {
        void request(`/session/${result.id}/end`, {}).catch(() => {}); return;
      }
      conversation.id = result.id;
      conversation.events = new EventSource(`${service}/session/${result.id}/events`);
      conversation.events.onmessage = event => { if (currentGeneration === generation) receive(JSON.parse(event.data)); };
      conversation.events.onerror = () => { if (currentGeneration === generation) stop('Connection lost. Please start another conversation.'); };
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      await new Promise((resolve, reject) => {
        if (channel.readyState === 'open') { resolve(); return; }
        const timeout = setTimeout(() => reject(new Error('Voice connection timed out. Please try again.')), 15_000);
        channel.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
      });
      if (currentGeneration !== generation) return;
      connecting = false; status.textContent = 'Listening…'; controls();
      peer.addEventListener('connectionstatechange', () => {
        if (currentGeneration === generation && ['failed', 'closed', 'disconnected'].includes(peer.connectionState)) stop('Voice disconnected. You can start again.');
      });
    } catch (error) {
      if (currentGeneration !== generation) return;
      // Capture can succeed before a peer/session exists, so clean both paths.
      if (!conversation) { stream?.getTracks().forEach(track => track.stop()); peer?.close(); if (audio) audio.srcObject = null; }
      stop(error.name === 'NotAllowedError' ? 'Microphone access was declined. You can still ask in text.' : error.name === 'NotFoundError' ? 'No microphone found. You can still ask in text.' : error.message === 'Failed to fetch' ? 'Aria is temporarily unavailable. Please try again.' : error.message);
    }
  }
  function createDialog() {
    dialog = document.createElement('dialog'); dialog.id = 'cv-aria-dialog';
    dialog.setAttribute('aria-labelledby', 'cv-aria-title');
    dialog.setAttribute('aria-describedby', 'cv-aria-description');
    const header = document.createElement('div'); header.className = 'cv-aria-header';
    const title = document.createElement('h2'); title.id = 'cv-aria-title'; title.append(mark(), document.createTextNode('Aria'));
    close = button('', 'x', () => dialog.close(), 'cv-aria-close'); close.setAttribute('aria-label', 'Close Aria');
    header.append(title, close);
    const description = document.createElement('p'); description.id = 'cv-aria-description';
    description.textContent = "Speak with Aria about Shane's work background and projects...";
    status = document.createElement('p'); status.className = 'cv-aria-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div'); actions.className = 'cv-aria-actions';
    start = button('Start conversation', 'mic', connect, 'cv-aria-start');
    mute = button('Mute', 'mic', () => {
      if (!conversation) return;
      conversation.muted = !conversation.muted;
      for (const track of conversation.stream.getAudioTracks()) track.enabled = !conversation.muted;
      status.textContent = conversation.muted ? 'Microphone muted.' : 'Listening…'; controls();
    });
    mute.hidden = true;
    actions.append(start, mute);
    const settings = document.createElement('label'); settings.className = 'cv-aria-voice'; settings.textContent = 'Voice';
    settings.hidden = true;
    voice = document.createElement('select'); voice.setAttribute('aria-label', 'Voice');
    settings.append(voice);
    transcript = document.createElement('div'); transcript.className = 'cv-aria-transcript';
    transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', 'Conversation transcript');
    transcript.setAttribute('aria-live', 'polite'); transcript.setAttribute('aria-relevant', 'additions'); transcript.tabIndex = 0;
    const form = document.createElement('form'); form.className = 'cv-aria-form';
    input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Or ask in text'; input.maxLength = 2000;
    input.setAttribute('aria-label', 'Ask Aria a question'); input.autocomplete = 'off';
    submit = button('', 'chevron-right', () => {}); submit.type = 'submit'; submit.setAttribute('aria-label', 'Send question');
    form.append(input, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); const prompt = input.value.trim(); if (!prompt || submit.disabled || !ready) return;
      submit.disabled = true; input.value = ''; message('user', prompt); status.textContent = 'Thinking…';
      const currentGeneration = generation;
      try {
        const result = await request('/ask', { prompt, sessionId: conversation?.id }, AbortSignal.timeout(50_000));
        if (dialog.open && currentGeneration === generation) { if (!conversation) message('assistant', result.answer); status.textContent = conversation ? 'Listening…' : 'Ready to talk.'; }
      } catch (error) { if (dialog.open && currentGeneration === generation) status.textContent = error.message === 'Failed to fetch' ? 'Aria is temporarily unavailable. Please try again.' : error.message; }
      finally { submit.disabled = !ready; }
    });
    const note = document.createElement('p'); note.className = 'cv-aria-note';
    note.textContent = 'AI voice guide • your microphone is active only during a conversation.';
    dialog.append(header, description, actions, settings, status, transcript, form, note);
    document.body.append(dialog);
    dialog.addEventListener('close', () => { stop(); returnFocus?.focus({ preventScroll: true }); });
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const elements = [...dialog.querySelectorAll('button, select, input, [tabindex="0"]')].filter(element => !element.disabled && !element.hidden && element.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }
  async function open(trigger) {
    if (!dialog) createDialog(); if (dialog.open) return;
    returnFocus = trigger; dialog.showModal(); close.focus();
    const openGeneration = generation;
    ready = false; controls(); submit.disabled = true; status.textContent = 'Connecting to Aria…';
    try {
      const response = await fetch(`${service}/status`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('Aria is temporarily unavailable. Please try again.');
      const info = await response.json();
      if (!dialog.open || generation !== openGeneration) return;
      voice.replaceChildren(...info.voices.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name[0].toUpperCase() + name.slice(1); return option; }));
      voice.value = 'cove';
      ready = info.authenticated; status.textContent = ready ? 'Ready to talk.' : info.message;
      if (!navigator.mediaDevices?.getUserMedia) { status.textContent = 'Voice needs a browser with microphone support. You can ask in text.'; start.disabled = true; }
    } catch { if (dialog.open && generation === openGeneration) status.textContent = 'Aria is temporarily unavailable. Please try again.'; }
    if (dialog.open && generation === openGeneration) { controls(); submit.disabled = !ready; }
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest('.cv-header-aria');
    if (!trigger) return;
    event.preventDefault(); void open(trigger);
  });
  window.addEventListener('pagehide', () => stop());
  const updateHeader = function () {
    if (!enabled()) return;
    const search = document.querySelector('.cv-search-item');
    if (search && !search.parentElement.querySelector('.cv-aria-item')) {
      const item = document.createElement('li'); item.className = 'cv-aria-item';
      const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'cv-header-aria';
      trigger.setAttribute('aria-label', 'Talk to Aria'); trigger.setAttribute('title', 'Talk to Aria');
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.append(mark()); item.append(trigger); search.after(item);
    }
    const mobile = document.getElementById('search-bar-entry-mobile');
    if (mobile && !mobile.parentElement.querySelector('.cv-header-aria')) {
      const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'cv-header-aria';
      trigger.setAttribute('aria-label', 'Talk to Aria'); trigger.setAttribute('title', 'Talk to Aria');
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.append(mark()); mobile.after(trigger);
    }
  };
  window[controller] = updateHeader;
  return updateHeader;
}
