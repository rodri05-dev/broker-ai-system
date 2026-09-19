(function () {
  const sessionToken = localStorage.getItem('chatSession') || crypto.randomUUID();
  localStorage.setItem('chatSession', sessionToken);

  const style = document.createElement('style');
  style.textContent = `
    #ai-chat-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;
      background:#152238;color:#fff;display:flex;align-items:center;justify-content:center;
      cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:Arial,sans-serif;font-size:24px;z-index:9999;}
    #ai-chat-panel{position:fixed;bottom:88px;right:20px;width:340px;max-height:460px;background:#fff;
      border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:none;flex-direction:column;
      overflow:hidden;font-family:Arial,sans-serif;z-index:9999;}
    #ai-chat-panel.open{display:flex;}
    #ai-chat-header{background:#152238;color:#fff;padding:14px 16px;font-size:0.95rem;}
    #ai-chat-log{flex:1;overflow-y:auto;padding:12px;font-size:0.88rem;line-height:1.4;}
    .ai-msg{margin-bottom:10px;padding:8px 12px;border-radius:12px;max-width:85%;}
    .ai-msg.user{background:#152238;color:#fff;margin-left:auto;}
    .ai-msg.bot{background:#f0eee8;color:#152238;}
    #ai-chat-input{display:flex;border-top:1px solid #eee;background:#faf9f6;}
    #ai-chat-input input{flex:1;border:none;padding:12px;font-size:0.88rem;outline:none;background:#faf9f6;color:#152238;}
    #ai-chat-input input::placeholder{color:#9aa1ac;}
    #ai-chat-input input:focus{background:#fff;}
    #ai-chat-input button{border:none;background:#152238;color:#fff;padding:0 16px;cursor:pointer;
  width:auto !important;flex:0 0 auto !important;white-space:nowrap;}
  `;
  document.head.appendChild(style);

  const bubble = document.createElement('div');
  bubble.id = 'ai-chat-bubble';
  bubble.textContent = '💬';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.id = 'ai-chat-panel';
  panel.innerHTML = `
    <div id="ai-chat-header">Talk to us about your business insurance</div>
    <div id="ai-chat-log"></div>
    <div id="ai-chat-input">
      <input type="text" placeholder="Type a message…" />
      <button>Send</button>
    </div>`;
  document.body.appendChild(panel);

  const log = panel.querySelector('#ai-chat-log');
  const input = panel.querySelector('input');
  const sendBtn = panel.querySelector('button');

  function addMsg(text, role) {
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  bubble.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && log.children.length === 0) {
      addMsg("Hi — what can I help you with? (New quote, certificate of insurance, or a renewal question?)", 'bot');
    }
  });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    const res = await fetch(window.AI_CHAT_ENDPOINT || '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, message: text })
    });
    const data = await res.json();
    addMsg(data.reply, 'bot');
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
})();