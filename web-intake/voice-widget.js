(function () {
  const ENDPOINT = window.AI_VOICE_ENDPOINT || '/api/voice-web/turn';
  const token = localStorage.getItem('aiVoiceSession') || crypto.randomUUID();
  localStorage.setItem('aiVoiceSession', token);

  const style = document.createElement('style');
  style.textContent = `
    #aiv-btn{position:fixed;bottom:20px;right:88px;height:56px;padding:0 22px;border:none;border-radius:28px;
      background:#152238;color:#fff;font:600 14px/1 Arial,Helvetica,sans-serif;cursor:pointer;
      box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:9998;}
    #aiv-panel{position:fixed;bottom:88px;right:20px;width:340px;background:#fff;border-radius:10px;
      box-shadow:0 8px 32px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;
      font-family:Arial,Helvetica,sans-serif;z-index:9998;}
    #aiv-panel.open{display:flex;}
    #aiv-head{background:#152238;color:#fff;padding:14px 16px;font-size:.95rem;display:flex;
      justify-content:space-between;align-items:center;}
    #aiv-head button{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;}
    #aiv-orb{height:96px;display:flex;align-items:center;justify-content:center;}
    #aiv-orb div{width:54px;height:54px;border-radius:50%;background:#152238;transition:transform .15s;}
    #aiv-orb.live div{background:#3c6e47;animation:aivp 1.1s ease-in-out infinite;}
    #aiv-orb.think div{background:#b3782c;animation:aivp .6s ease-in-out infinite;}
    @keyframes aivp{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}
    #aiv-status{text-align:center;font-size:.8rem;color:#6b7688;padding-bottom:10px;}
    #aiv-log{max-height:190px;overflow-y:auto;padding:10px 14px 16px;font-size:.85rem;line-height:1.45;}
    .aiv-m{margin-bottom:8px;padding:7px 11px;border-radius:12px;max-width:88%;}
    .aiv-m.you{background:#152238;color:#fff;margin-left:auto;}
    .aiv-m.bot{background:#f0eee8;color:#152238;}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'aiv-btn';
  btn.textContent = '🎙 Talk to us';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'aiv-panel';
  panel.innerHTML = `
    <div id="aiv-head"><span>Talk about your business insurance</span><button id="aiv-x">✕</button></div>
    <div id="aiv-orb"><div></div></div>
    <div id="aiv-status">Click the button to start</div>
    <div id="aiv-log"></div>`;
  document.body.appendChild(panel);

  const orb = panel.querySelector('#aiv-orb');
  const statusEl = panel.querySelector('#aiv-status');
  const log = panel.querySelector('#aiv-log');

  let stream, recorder, chunks = [], audioCtx, listening = false, active = false;
  let silenceTimer = null, maxTimer = null;

  const setStatus = (t, mode) => {
    statusEl.textContent = t;
    orb.className = mode || '';
  };

  function say(text, who) {
    const d = document.createElement('div');
    d.className = `aiv-m ${who}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  async function startCall() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus('Microphone blocked — allow mic access and try again');
      return;
    }
    active = true;
    btn.textContent = '■ End';
    panel.classList.add('open');
    if (!log.children.length) {
      const greeting = "Hi — what can I help you with? A new quote, a certificate of insurance, or a renewal question?";
      say(greeting, 'bot');
      speak(greeting, null, listen);
    } else {
      listen();
    }
  }

  function endCall() {
    active = false;
    stopTimers();
    listening = false;
    try { recorder && recorder.state !== 'inactive' && recorder.stop(); } catch {}
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    try { audioCtx && audioCtx.close(); } catch {}
    window.speechSynthesis && window.speechSynthesis.cancel();
    btn.textContent = '🎙 Talk to us';
    setStatus('Call ended');
  }

  function stopTimers() {
    clearTimeout(silenceTimer); silenceTimer = null;
    clearTimeout(maxTimer); maxTimer = null;
  }

  function listen() {
    if (!active) return;
    chunks = [];
    recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onstop = send;
    recorder.start();
    listening = true;
    setStatus('Listening…', 'live');
    watchLevel();
    maxTimer = setTimeout(stopListening, 22000); // hard cap on one utterance
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    stopTimers();
    try { recorder.state !== 'inactive' && recorder.stop(); } catch {}
  }

  // Stop recording ~1.2s after the person stops making noise.
  function watchLevel() {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    let spoke = false;

    (function tick() {
      if (!listening) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);

      if (rms > 0.035) {
        spoke = true;
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      } else if (spoke && !silenceTimer) {
        silenceTimer = setTimeout(stopListening, 1200);
      }
      requestAnimationFrame(tick);
    })();
  }

  async function send() {
    if (!active) return;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size < 2000) return listen(); // nothing was said
    setStatus('Thinking…', 'think');

    const b64 = await new Promise(resolve => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.readAsDataURL(blob);
    });

    let data;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken: token, audio: b64,
          mimeType: (recorder.mimeType || 'audio/webm').split(';')[0]
        })
      });
      data = await res.json();
    } catch {
      setStatus('Connection problem — try again');
      return listen();
    }

    if (data.empty && !data.transcript) return listen();
    if (data.transcript) say(data.transcript, 'you');
    if (!data.reply) return listen();

    say(data.reply, 'bot');
    speak(data.reply, data.audio, () => (data.done ? endCall() : listen()));
  }

  // Groq audio if the server sent it, otherwise the browser's own free voice.
  function speak(text, audioB64, onDone) {
    setStatus('Speaking…');
    if (audioB64) {
      const audio = new Audio('data:audio/wav;base64,' + audioB64);
      audio.onended = onDone;
      audio.onerror = onDone;
      audio.play().catch(onDone);
      return;
    }
    if (!window.speechSynthesis) return onDone();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.03;
    u.onend = onDone;
    u.onerror = onDone;
    window.speechSynthesis.speak(u);
  }

  btn.addEventListener('click', () => (active ? endCall() : startCall()));
  panel.querySelector('#aiv-x').addEventListener('click', () => { endCall(); panel.classList.remove('open'); });
})();